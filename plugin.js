// prompt-queue — kanban-style prompt queue for Hermes Desktop.
//
// Each card = a prompt. Play (manual) drains the queue strictly top-down:
//   GLOBAL GATE (any session working?) → session.create → prompt.submit →
//   wait turn (message.complete for that session) → strict review gate
//   (no background review may still be running) → mark done → close the
//   one-shot session's slot → next card.
// Every card gets a REAL desktop session (visible in the sidebar); its
// active-session slot is released after the turn so a long queue can't
// exhaust the cap.
//
// TWO independent gates protect the single local-model slot:
//   1. Global session gate — session.active_list (authoritative,
//      process-wide): holds while ANY live session is working/starting/
//      queued — user follow-ups in other sessions, other surfaces, or a
//      card's own sub-agents. (The v1 per-card busyBySession wait only
//      saw sessions the renderer tracked; a follow-up slipped past it.)
//   2. Per-card review gate — background reviews run on a thread, NOT a
//      TUI session, so they never appear in active_list. Log-marker
//      detection (below) + 30 s spawn grace covers the turn→review fork
//      delay.
//
// Renderer-only disk plugin (loaded uncompiled): only @hermes/plugin-sdk /
// react / react/jsx-runtime resolve. UI is written with jsx() calls.
//
// State: ctx.storage JSON ({v, cards, playing}). Card:
//   { id, text, title, status, sid?, stored?, err?, ts, doneAt? }
//   status: queued | launching | running | review-wait | done | failed
//
// Review gate (lifted from bg-review-watch): at most one background review
// runs at a time; running ⇔ latest spawn ts > latest completion ts.
//   spawn: "<ts>,… OpenAI client created … thread=bg-review:<pid>"
//          (the anchor is load-bearing — retired/closed teardown lines also
//           carry thread=bg-review:<pid> and arrive AFTER the completion)
//   done:  "Background review complete" / "Background memory/skill review failed"

import { host, Tip, STATUSBAR_AREAS, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect, useRef } from 'react'

// ── constants ───────────────────────────────────────────────────────────────
const STORE_KEY = 'prompt-queue-state-v1'
const REVIEW_POLL_MS = 20000
const TURN_FALLBACK_POLL_MS = 10000
const TURN_STALL_MS = 60 * 60 * 1000 // hard fail: turn never completes for an hour
const REVIEW_SPAWN_GRACE_MS = 30000 // reviews fork AFTER the turn ends; wait this long before accepting "none spawned"
const CLOSE_AFTER_DONE_MS = 3000
const SUBMIT_RETRIES = 3
const GLOBAL_POLL_MS = 4000 // cadence for the process-wide "any session working" gate
const RE_START = /(^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*OpenAI client created.*thread=bg-review:(\d+)/
const RE_DONE = /(^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*(Background review complete|Background memory\/skill review failed)/

// ── small utils ─────────────────────────────────────────────────────────────
function lineText(l) { return typeof l === 'string' ? l : (l && (l.line || l.message || l.text)) || '' }
function tsOf(s) { const d = new Date(s.replace(' ', 'T')); return isNaN(d) ? null : d.getTime() }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
function sanitizeTitle(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Queue card'
}
function ago(ms) {
  if (ms == null) return '…'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
function isBusy(sid) {
  try {
    const m = host.state.busyBySession.get()
    return !!(m && m[sid])
  } catch { return false }
}
function errMsg(e) {
  return (e && (e.message || e.error || e.code)) ? String(e.message || e.error || e.code) : String(e)
}

// ── module-scoped store (survives pane remounts + hot reload) ───────────────
let state = { cards: [], playing: false, hydrated: false, modelBusy: false }
const subs = new Set()
let persistTimer = null
let engineCtx = null

function emit() { subs.forEach((f) => f()) }
function set(patch) { state = { ...state, ...patch }; persist(); emit() }
function card(id) { return state.cards.find((c) => c.id === id) }
function patchCard(id, patch) {
  if (!card(id)) return
  set({ cards: state.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
}
function persist() {
  if (persistTimer) return
  persistTimer = setTimeout(async () => {
    persistTimer = null
    try {
      if (engineCtx && engineCtx.storage) {
        await engineCtx.storage.set(STORE_KEY, { v: 1, cards: state.cards, playing: false })
      }
    } catch { /* storage blip — retried on the next transition */ }
  }, 400)
}

function useQueue() {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb) },
    () => state,
    () => state,
  )
}

// ── review gate ─────────────────────────────────────────────────────────────
async function reviewState() {
  const res = await host.logs({ file: 'agent', lines: 1000, search: 'bg-review' })
  const lines = ((res && (res.lines || res.data || res.logs)) || []).map(lineText)
  let spawn = null
  let done = null
  for (const text of lines) {
    let m = RE_DONE.exec(text)
    if (m) {
      const t = tsOf(m[1])
      if (t && (done == null || t > done)) done = t
      continue
    }
    m = RE_START.exec(text)
    if (m) {
      const t = tsOf(m[1])
      if (t && (spawn == null || t > spawn)) spawn = t
    }
  }
  return { spawn, done }
}

// Strict gate: false while ANY background review is still running (this
// turn's or an earlier one). A log REST blip fails open (matches
// bg-review-watch) — the 20 s re-poll retries.
async function reviewCleared() {
  try {
    const r = await reviewState()
    const active = r.spawn != null && (r.done == null || r.spawn > r.done)
    return !active
  } catch {
    return true
  }
}

// ── global model-slot gate ─────────────────────────────────────────────────
// session.active_list is the AUTHORITATIVE process-wide signal (gateway
// source: _session_live_status → 'working' mid-turn, 'starting' agent
// build, 'waiting' queued prompt, 'idle'). Renderer-derived busyBySession
// only sees sessions the UI tracks, which is how a user follow-up in
// another session used to slip past the queue.
async function anySessionWorking() {
  try {
    const res = await host.request('session.active_list', {})
    const rows = (res && res.sessions) || []
    return rows.some((s) => s.status === 'working' || s.status === 'starting' || s.status === 'waiting')
  } catch {
    return false // RPC blip: one 4s cycle of fail-open, next cycle re-checks
  }
}

// Resolves 'free' after two consecutive clear readings (kills single-blip
// false-clears), 'paused' if the queue stops playing while waiting.
function waitForModelFree() {
  return new Promise((resolve) => {
    let clearStreak = 0
    let stopped = false
    let interval = null
    const check = async () => {
      if (stopped) return
      const busy = await anySessionWorking()
      if (stopped) return
      set({ modelBusy: busy })
      if (!state.playing) {
        stopped = true
        if (interval) clearInterval(interval)
        set({ modelBusy: false })
        resolve('paused')
        return
      }
      if (busy) clearStreak = 0
      else if (++clearStreak >= 2) {
        stopped = true
        if (interval) clearInterval(interval)
        set({ modelBusy: false })
        resolve('free')
      }
    }
    check() // immediately — a just-freed model shouldn't wait a full cycle
    interval = setInterval(check, GLOBAL_POLL_MS)
  })
}

// ── engine ──────────────────────────────────────────────────────────────────
let inFlight = 0
const turnTimers = new Map()   // card id → { interval, timeout }
const reviewTimers = new Map() // card id → interval

async function submitWithRetry(sid, text) {
  let lastErr = null
  for (let i = 0; i < SUBMIT_RETRIES; i++) {
    try {
      return await host.request('prompt.submit', { session_id: sid, text })
    } catch (e) {
      lastErr = e
      if (i < SUBMIT_RETRIES - 1) await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

async function pump() {
  if (inFlight > 0 || !state.playing) return
  const next = state.cards.find((c) => c.status === 'queued')
  if (!next) { set({ modelBusy: false }); return }
  inFlight++
  try {
    // GLOBAL GATE: hold while ANY live session is working/starting/queued
    // (user follow-ups, other surfaces, a card's own sub-agents) — the
    // model is single-slot, and this is what a follow-up in another
    // session used to slip past (per-card waitTurn only watched its own
    // session).
    const verdict = await waitForModelFree()
    if (verdict === 'paused' || !state.playing) return
    await runCard(next.id)
  } catch (e) {
    patchCard(next.id, { status: 'failed', err: 'engine: ' + errMsg(e), ts: Date.now() })
  } finally {
    inFlight--
    if (state.playing) setTimeout(pump, 250)
  }
}

async function runCard(id) {
  const c = card(id)
  if (!c) return

  // 1 — create the real session
  // Final pre-launch check: the global gate again, so a review that forked
  // after the per-card spawn grace closed still holds the next card.
  const pre = await anySessionWorking()
  if (pre) {
    const v2 = await waitForModelFree()
    if (v2 === 'paused') return
  }
  patchCard(id, { status: 'launching', ts: Date.now(), err: null })
  let created
  try {
    created = await host.request('session.create', { title: c.title })
  } catch (e) {
    patchCard(id, { status: 'failed', err: 'session.create: ' + errMsg(e), ts: Date.now() })
    return
  }
  const sid = created && (created.session_id || created.sessionId)
  const stored = created && (created.stored_session_id || created.storedSessionId)
  if (!sid) {
    patchCard(id, { status: 'failed', err: 'session.create returned no id', ts: Date.now() })
    return
  }
  patchCard(id, { sid, stored, status: 'running', ts: Date.now() })

  // 2 — send the prompt
  try {
    await submitWithRetry(sid, c.text)
  } catch (e) {
    patchCard(id, { status: 'failed', err: 'prompt.submit: ' + errMsg(e), ts: Date.now() })
    host.request('session.close', { session_id: sid }).catch(() => {})
    return
  }

  // 3 — wait for turn completion
  const ok = await waitTurn(id, sid)
  const cur = card(id)
  if (!cur || cur.status === 'failed' || cur.status === 'done') return // removed/failed meanwhile
  if (!ok) {
    patchCard(id, { status: 'failed', err: 'turn stall: no completion after 1h (session left open)', ts: Date.now() })
    return // don't close a session that may still be working
  }

  // 4 — strict review gate (reviews fork AFTER the turn ends)
  patchCard(id, { status: 'review-wait', ts: Date.now() })
  await waitReview(id)
  const cur2 = card(id)
  if (!cur2 || cur2.status === 'failed') return

  // 5 — done + free the active-session slot (the sidebar row stays)
  patchCard(id, { status: 'done', doneAt: Date.now(), ts: Date.now() })
  setTimeout(() => {
    host.request('session.close', { session_id: sid }).catch(() => {})
  }, CLOSE_AFTER_DONE_MS)
}

// Resolves true when the turn completed (event or busy=false watchdog),
// false on the 1h stall.
function waitTurn(id, sid) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      const t = turnTimers.get(id)
      if (t) { clearInterval(t.interval); clearTimeout(t.timeout); turnTimers.delete(id) }
      resolve(ok)
    }
    const interval = setInterval(() => {
      const c = card(id)
      if (!c) return finish(true)
      if (c.status !== 'running' && c.status !== 'launching') return finish(true)
      if (!isBusy(sid)) {
        // busy cleared — give a late message.complete a beat to land first
        setTimeout(() => {
          const c2 = card(id)
          if (c2 && (c2.status === 'running' || c2.status === 'launching')) finish(true)
        }, 5000)
      }
    }, TURN_FALLBACK_POLL_MS)
    const timeout = setTimeout(() => finish(false), TURN_STALL_MS)
    turnTimers.set(id, { interval, timeout })
  })
}

// Resolves once no background review is running, after the spawn grace.
function waitReview(id) {
  return new Promise((resolve) => {
    let settled = false
    const startedAt = Date.now()
    const finish = () => {
      if (settled) return
      settled = true
      const t = reviewTimers.get(id)
      if (t) clearInterval(t)
      reviewTimers.delete(id)
      resolve()
    }
    const check = async () => {
      if (settled) return
      const c = card(id)
      if (!c || c.status !== 'review-wait') return finish()
      if (Date.now() - startedAt < REVIEW_SPAWN_GRACE_MS) return
      if (await reviewCleared()) finish()
    }
    reviewTimers.set(id, setInterval(check, REVIEW_POLL_MS))
  })
}

// ── user actions ────────────────────────────────────────────────────────────
function play() {
  if (!state.playing) {
    set({ playing: true })
    setTimeout(pump, 100)
  }
}
function pause() { set({ playing: false }) }
function addCard(text) {
  const t = (text || '').trim()
  if (!t) return
  set({ cards: [...state.cards, { id: uid(), text: t, title: sanitizeTitle(t), status: 'queued', ts: Date.now() }] })
}
function removeCard(id) {
  const c = card(id)
  if (!c) return
  if (c.status === 'launching' || c.status === 'running' || c.status === 'review-wait') return
  set({ cards: state.cards.filter((x) => x.id !== id) })
}
function clearDone() { set({ cards: state.cards.filter((c) => c.status !== 'done') }) }
function openCardSession(c) {
  if (c.stored) host.openSession(c.stored).catch(() => {})
}
function retryCard(id) {
  patchCard(id, { status: 'queued', err: null, sid: null, stored: null, ts: Date.now() })
  if (!state.playing) setTimeout(pump, 50)
}
function reorderCard(fromId, targetId) {
  const cards = [...state.cards]
  const fi = cards.findIndex((c) => c.id === fromId)
  const ti = cards.findIndex((c) => c.id === targetId)
  if (fi < 0 || ti < 0 || fi === ti) return
  const [item] = cards.splice(fi, 1)
  cards.splice(ti, 0, item)
  set({ cards })
}

// ── hydration (restart-safe) ────────────────────────────────────────────────
async function hydrate() {
  if (state.hydrated) return
  try {
    const s = await engineCtx.storage.get(STORE_KEY)
    if (s && Array.isArray(s.cards)) {
      const busy = (host.state.busyBySession.get() || {})
      const cards = s.cards.map((c) => {
        if (c.status === 'launching' || c.status === 'running') {
          if (c.sid && busy[c.sid]) return { ...c, status: 'running', err: 're-attached after restart' }
          if (c.sid && c.stored) return { ...c, status: 'review-wait', err: 're-attached after restart' }
          return { ...c, status: 'queued', err: 'interrupted before completion — re-queued' }
        }
        return c
      })
      set({ cards, playing: false, hydrated: true })
      // resume re-attached cards through the same wait machinery (per-card
      // timers, so no clash with a later Play)
      cards.forEach((c) => {
        if (c.status === 'running') {
          waitTurn(c.id, c.sid).then((ok) => {
            const cur = card(c.id)
            if (!cur || cur.status !== 'running') return
            if (!ok) { patchCard(c.id, { status: 'failed', err: 'turn stall: no completion after 1h (session left open)', ts: Date.now() }); return }
            patchCard(c.id, { status: 'review-wait', ts: Date.now() })
            waitReview(c.id).then(() => {
              const cur2 = card(c.id)
              if (cur2 && cur2.status === 'review-wait') patchCard(c.id, { status: 'done', doneAt: Date.now() })
            })
          })
        } else if (c.status === 'review-wait') {
          waitReview(c.id).then(() => {
            const cur = card(c.id)
            if (cur && cur.status === 'review-wait') patchCard(c.id, { status: 'done', doneAt: Date.now() })
          })
        }
      })
    } else {
      set({ hydrated: true })
    }
  } catch {
    set({ hydrated: true }) // fail-open: empty queue
  }
}

// ── global event wiring ─────────────────────────────────────────────────────
let eventOff = null
function ensureWired() {
  if (eventOff) return
  eventOff = host.onEvent('message.complete', (ev) => {
    const sid = ev && ev.session_id
    if (!sid) return
    const c = state.cards.find((x) => x.sid === sid && (x.status === 'running' || x.status === 'launching'))
    if (!c) return
    // let the commit settle, then promote if the watchdog hasn't beaten us
    setTimeout(() => {
      const c2 = card(c.id)
      if (c2 && (c2.status === 'running' || c2.status === 'launching') && !isBusy(sid)) {
        patchCard(c2.id, { status: 'review-wait', ts: Date.now() })
      }
    }, 2500)
  })
}
function teardownWired() {
  if (eventOff) { try { eventOff() } catch { /* */ } eventOff = null }
  turnTimers.forEach((t) => { clearInterval(t.interval); clearTimeout(t.timeout) })
  turnTimers.clear()
  reviewTimers.forEach((t) => clearInterval(t))
  reviewTimers.clear()
}

// ── UI ──────────────────────────────────────────────────────────────────────
const STATUS_META = {
  queued: { color: 'var(--ui-text-quaternary)', label: 'queued' },
  launching: { color: 'var(--ui-text-secondary)', label: 'launching' },
  running: { color: 'var(--ui-accent)', label: 'running' },
  'review-wait': { color: 'var(--ui-accent)', label: 'review gate' },
  done: { color: 'var(--ui-text-quaternary)', label: 'done' },
  failed: { color: 'var(--ui-text-secondary)', label: 'failed' },
}

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META.queued
  return jsx('span', {
    'aria-hidden': true,
    style: {
      width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
      background: meta.color, display: 'inline-block',
      animation: status === 'running' ? 'pq-pulse 1.2s ease-in-out infinite' : 'none',
    },
  })
}

function CardRow({ c, onDragStart, onDropOn }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const meta = STATUS_META[c.status] || STATUS_META.queued
  const live = c.status === 'running' || c.status === 'launching' || c.status === 'review-wait'
  const elapsed = (c.status === 'running' || c.status === 'review-wait' || c.status === 'launching') ? Date.now() - (c.ts || Date.now()) : null
  return jsxs('div', {
    draggable: !live,
    onDragStart: (e) => onDragStart(e, c.id),
    onDragOver: (e) => e.preventDefault(),
    onDrop: (e) => { e.preventDefault(); onDropOn(c.id) },
    style: {
      display: 'flex', alignItems: 'flex-start', gap: '6px',
      padding: '5px 6px', borderRadius: '6px',
      background: live ? 'color-mix(in srgb, var(--ui-accent) 7%, transparent)' : 'transparent',
      border: '1px solid ' + (live ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'),
      opacity: c.status === 'done' ? 0.55 : 1,
    },
    children: [
      jsx('span', {
        style: { cursor: live ? 'default' : 'grab', color: 'var(--ui-text-quaternary)', fontSize: '0.625rem', lineHeight: '1.5rem', userSelect: 'none' },
        children: '⋮⋮',
      }),
      jsx(StatusDot, { status: c.status }),
      jsxs('div', {
        style: { flex: 1, minWidth: 0, fontSize: '0.75rem', lineHeight: '1.35', color: 'var(--ui-text-secondary)' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '6px' },
            children: [
              jsx('span', {
                style: { fontWeight: 600, color: 'var(--ui-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 },
                children: c.title,
              }),
              jsx('span', {
                style: { fontSize: '0.625rem', color: meta.color, whiteSpace: 'nowrap', flexShrink: 0 },
                children: meta.label + (elapsed != null ? ` · ${ago(elapsed)}` : ''),
              }),
            ],
          }),
          editing
            ? jsx('textarea', {
                value: draft,
                autoFocus: true,
                onChange: (e) => setDraft(e.target.value),
                onBlur: () => {
                  const t = draft.trim()
                  if (t && t !== c.text) patchCard(c.id, { text: t, title: sanitizeTitle(t) })
                  setEditing(false)
                },
                rows: 2,
                style: { width: '100%', fontSize: '0.7rem', marginTop: '3px', background: 'transparent', color: 'var(--ui-text-secondary)', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '4px', resize: 'vertical' },
              })
            : c.status === 'failed'
              ? jsx('div', {
                  style: { fontSize: '0.65rem', color: 'var(--ui-text-secondary)', marginTop: '2px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                  children: c.err || 'unknown error',
                })
              : jsx('div', {
                  style: { fontSize: '0.65rem', color: 'var(--ui-text-quaternary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '1px' },
                  children: c.text,
                }),
        ],
      }),
      jsxs('div', {
        style: { display: 'flex', gap: '2px', flexShrink: 0, height: '1.5rem', alignItems: 'center' },
        children: [
          c.stored && !live
            ? jsx('button', {
                title: 'Open session',
                onClick: () => openCardSession(c),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
                children: '↗',
              })
            : null,
          !live && !editing
            ? jsx('button', {
                title: 'Edit',
                onClick: () => { setDraft(c.text); setEditing(true) },
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
                children: '✎',
              })
            : null,
          c.status === 'failed'
            ? jsx('button', {
                title: 'Retry',
                onClick: () => retryCard(c.id),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-accent)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
                children: '↻',
              })
            : null,
          !live
            ? jsx('button', {
                title: 'Remove',
                onClick: () => removeCard(c.id),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
                children: '×',
              })
            : null,
        ],
      }),
    ],
  })
}

function Board() {
  const q = useQueue()
  const [draft, setDraft] = useState('')
  const dragId = useRef(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const counts = {
    queued: q.cards.filter((c) => c.status === 'queued').length,
    done: q.cards.filter((c) => c.status === 'done').length,
    failed: q.cards.filter((c) => c.status === 'failed').length,
  }
  const submit = () => { addCard(draft); setDraft('') }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '140px', fontFamily: 'inherit' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderBottom: '1px solid var(--ui-stroke-secondary)' },
        children: [
          jsx('button', {
            title: q.playing ? 'Pause queue' : 'Play queue — the next queued card starts a new session',
            onClick: () => (q.playing ? pause() : play()),
            style: {
              border: '1px solid ' + (q.playing ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'),
              background: q.playing ? 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' : 'transparent',
              color: q.playing ? 'var(--ui-accent)' : 'var(--ui-text-secondary)',
              borderRadius: '6px', cursor: 'pointer', padding: '2px 10px', fontSize: '0.7rem', fontWeight: 600,
            },
            children: q.playing ? '❚❚ Pause' : '▶ Play',
          }),
          jsx('span', {
            style: { fontSize: '0.65rem', color: q.playing && q.modelBusy ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)', marginLeft: 'auto' },
            children: q.playing && q.modelBusy
              ? '⏳ waiting for model…'
              : `${counts.queued} queued · ${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''}`,
          }),
          counts.done > 0
            ? jsx('button', {
                title: 'Clear done cards',
                onClick: () => clearDone(),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 4px', borderRadius: '3px' },
                children: '✕ done',
              })
            : null,
        ],
      }),
      jsx('div', {
        style: { flex: 1, overflowY: 'auto', padding: '6px', display: 'flex', flexDirection: 'column', gap: '5px' },
        children: q.cards.length === 0
          ? jsx('div', {
              style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', padding: '12px 6px', textAlign: 'center' },
              children: 'Empty. Add a prompt below — each one runs in its own new session, visible in the sidebar.',
            })
          : q.cards.map((c) =>
              jsx(CardRow, {
                key: c.id,
                c,
                onDragStart: (e, id) => {
                  dragId.current = id
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', id) } catch { /* some runtimes */ }
                },
                onDropOn: (targetId) => {
                  const from = dragId.current
                  dragId.current = null
                  if (from && from !== targetId) reorderCard(from, targetId)
                },
              }),
            ),
      }),
      jsxs('div', {
        style: { display: 'flex', gap: '5px', padding: '6px 8px', borderTop: '1px solid var(--ui-stroke-secondary)', alignItems: 'flex-end' },
        children: [
          jsx('textarea', {
            placeholder: 'Add a prompt… (each = new session)',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
            },
            rows: 2,
            style: {
              flex: 1, fontSize: '0.7rem', resize: 'none',
              background: 'transparent',
              color: 'var(--ui-text-secondary)',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: '5px', padding: '4px 6px',
            },
          }),
          jsx('button', {
            onClick: submit,
            disabled: !draft.trim(),
            style: {
              border: '1px solid var(--ui-stroke-secondary)', background: 'transparent',
              color: draft.trim() ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)',
              borderRadius: '5px', cursor: draft.trim() ? 'pointer' : 'default',
              fontSize: '0.7rem', padding: '4px 8px',
            },
            children: '+ Add',
          }),
        ],
      }),
    ],
  })
}

function Chip() {
  const q = useQueue()
  const active = q.cards.filter((c) => ['launching', 'running', 'review-wait'].includes(c.status)).length
  const queued = q.cards.filter((c) => c.status === 'queued').length
  let label
  let color
  if (q.playing && q.modelBusy) {
    label = 'queue · waiting for model'
    color = 'var(--ui-accent)'
  } else if (q.playing) {
    label = `queue · ${active || 0} active, ${queued} next`
    color = 'var(--ui-accent)'
  } else if (queued) {
    label = `queue paused · ${queued} waiting`
    color = 'var(--ui-text-tertiary)'
  } else {
    label = 'queue idle'
    color = 'var(--ui-text-tertiary)'
  }
  return jsxs(Tip, {
    label: q.playing && q.modelBusy
      ? 'A session is still using the model (your follow-ups, other surfaces, or a card\'s sub-agents). The queue holds the next prompt until it — and any background review — is fully done.'
      : q.playing
        ? 'Prompt queue is draining: each card becomes a new session, strictly one at a time, gated on every session finishing + background-review completion.'
        : queued
          ? 'Prompt queue is paused. Press Play on the board (bottom-left) to resume.'
          : 'Prompt queue: add prompts on the board (bottom-left). Play drains them one by one into new sessions.',
    children: jsxs('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '5px', height: '100%', padding: '0 6px', fontSize: '0.6875rem', color, whiteSpace: 'nowrap' },
      children: [
        jsx('span', {
          style: { width: '6px', height: '6px', borderRadius: '50%', background: color, display: 'inline-block', animation: q.playing ? 'pq-pulse 1.2s ease-in-out infinite' : 'none' },
        }),
        jsx('span', { children: label }),
      ],
    }),
  })
}

// ── ::enqueue directive ─────────────────────────────────────────────────────
const enqueuedKeys = new Set()
function EnqueueChip({ prompt, key }) {
  const [phase, setPhase] = useState('pending')
  useEffect(() => {
    if (enqueuedKeys.has(key)) { setPhase('seen'); return }
    enqueuedKeys.add(key)
    if (!prompt || prompt.length > 2000) { setPhase('invalid'); return }
    addCard(prompt)
    setPhase('added')
  }, [key, prompt])
  const style = { color: 'var(--ui-text-quaternary)', fontSize: '0.7rem' }
  if (phase === 'added') return jsx('span', { style, children: '✓ added to prompt queue' })
  if (phase === 'seen') return jsx('span', { style, children: '✓ in prompt queue' })
  if (phase === 'invalid') return jsx('span', { style, children: '::enqueue — prompt missing or too long (max 2000 chars)' })
  return jsx('span', { style, children: '… adding to prompt queue' })
}

export default {
  id: 'prompt-queue',
  name: 'Prompt Queue',
  defaultEnabled: true,
  register(ctx) {
    engineCtx = ctx
    ensureWired()
    hydrate()

    let styleEl = null
    try {
      styleEl = document.createElement('style')
      styleEl.textContent = '@keyframes pq-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }'
      document.head.appendChild(styleEl)
    } catch { /* no DOM — skip */ }

    const paneDispose = ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Prompt Queue',
      data: {
        placement: 'left',
        width: '280px',
        // bottom-left: below the session list. No enforce — Arthur can drag it anywhere.
        dock: { pane: 'sessions', pos: 'bottom' },
      },
      render: () => jsx(Board, {}),
    })
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 141,
      render: () => jsx(Chip, {}),
    })
    ctx.register({
      id: 'enqueue',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'enqueue',
        render: ({ attrs }) => {
          const prompt = attrs && attrs.prompt
          const key = (attrs && attrs.id) || (prompt || '').slice(0, 200)
          return jsx(EnqueueChip, { key, prompt, attrs: undefined })
        },
      },
    })

    ctx.onDispose(() => {
      teardownWired()
      if (paneDispose) paneDispose()
      if (styleEl && styleEl.remove) styleEl.remove()
      if (engineCtx === ctx) engineCtx = null
    })
  },
}
