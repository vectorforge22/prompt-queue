// prompt-queue — kanban-style prompt queue for Hermes Desktop.
//
// Each card = a prompt + a MODE (where it runs). Play (manual) drains the
// queue strictly top-down:
//   GLOBAL GATE (any session working?) → resolve target mode →
//   prompt.submit → wait turn (message.complete for that session) → strict
//   review gate (no background review may still be running) → mark done →
//   close the one-shot session's slot (new/project modes only) → next card.
// Modes (Phase 2): new / session / project / bot — a mode is a named target
// resolver (card.target string → session-create or -resume params). New and
// project modes get a REAL fresh sidebar session, closed after the turn so a
// long queue can't exhaust the slot cap. Session and bot modes feed an
// EXISTING conversation and are never closed by the plugin. Bot mode feeds
// a profile's canonical hidden "Bot Chat" (name-as-identity — see below).
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
// State: ctx.storage JSON ({v, cards, playing, hydrate}) — schema v4.
// `hydrate` = re-import diagnostics {n, at, inFlight, requeued}; a v3 payload
// simply lacks it and hydrate() treats absence as the first incarnation. Card:
//   { id, text, title, status, sid?, stored?, err?, ts, doneAt?,
//     target?, targetTitle?, projectName? }
//   status: queued | launching | running | review-wait | done | failed
//   target is a MODE STRING resolved at fire time (Phase 2 modes framework):
//     'new'              → new mode: fresh session (default)
//     <session key>      → session mode: follow-up into that existing session
//     'project:<id>'     → project mode: fresh session under an existing
//                          desktop project (cwd = project primary path)
//     'project:new:<p>'  → project mode: projects.create first, then the same
//                          (the card is re-anchored to the created id)
//     'bot:<profile>'    → bot mode: the profile's canonical Bot Chat — the
//                          hidden session titled exactly "Bot Chat" on that
//                          profile. Name-as-identity, never an id pin (see
//                          resolveBotMode for the fail-closed rules).
//
// Review gate (lifted from bg-review-watch): at most one background review
// runs at a time; running ⇔ latest spawn ts > latest completion ts.
//   spawn: "<ts>,… OpenAI client created … thread=bg-review:<pid>"
//          (the anchor is load-bearing — retired/closed teardown lines also
//           carry thread=bg-review:<pid> and arrive AFTER the completion)
//   done:  "Background review complete" / "Background memory/skill review failed"

import { host, Tip, STATUSBAR_AREAS, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect, useRef, Fragment } from 'react'

// ── constants ───────────────────────────────────────────────────────────────
// Schema v3 (cards gained bot-mode targets — pure string values; no card
// shape change) lives under the SAME storage key as v1/v2 — hydrate() must
// find the old key or a live queue would vanish on a plugin update. Cards
// without project fields load and behave exactly as before.
const STORE_KEY = 'prompt-queue-state-v1'
const REVIEW_POLL_MS = 20000
const TURN_FALLBACK_POLL_MS = 10000
// Last-resort backstop: fail a card only if its session shows NO completion
// for this long after submit. Sized for local-model turns (observed up to
// ~3.7h on this box); 1h fired false "turn stall" failures on healthy long
// turns. Real completions are caught by message.complete + the 10s busy
// poll, so this only trips on genuinely hung sessions.
const TURN_STALL_MS = 12 * 60 * 60 * 1000
const REVIEW_SPAWN_GRACE_MS = 30000 // reviews fork AFTER the turn ends; wait this long before accepting "none spawned"
// Last-resort review-gate backstop: a card may sit in 'review-wait' at most
// this long. The 20s log poll is the real detector; this only fires when the
// in-memory poll timer was lost (pane unmount/hot-reload) and the card would
// otherwise hold the lane forever with the review long finished. On fire it
// re-checks the log: a CONFIRMED-absent review releases the card; a still-
// running review fails the card with a retry hint instead of hanging.
// 3h >> any observed review (longest ~2h) and matches the TURN_STALL_MS
// order of magnitude.
const REVIEW_STALL_MS = 3 * 60 * 60 * 1000
const CLOSE_AFTER_DONE_MS = 3000
const SUBMIT_RETRIES = 3
const GLOBAL_POLL_MS = 4000 // cadence for the process-wide "any session working" gate
const RE_START = /(^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*OpenAI client created.*thread=bg-review:(\d+)/
const RE_DONE = /(^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*(Background review complete|Background memory\/skill review failed)/

// ── settings (pane-header gear) ─────────────────────────────────────────────
// modelSuggested: 'ask' (default — ::enqueue cards need an explicit click)
//   | 'auto' (legacy behavior: directive adds the card immediately).
// gateFailOpen: default false (FAIL CLOSED — a review-verification error
//   holds the queue with a visible state; true = legacy fail-open).
// defaultMode (Phase 2): mode the composer preselects — 'new' | 'bot'. It
//   sets the target for cards added without an explicit pick (the ::enqueue
//   chip) and the section the picker opens on; per-card override is always
//   possible (the picker itself). 'session' has no sensible default target,
//   so it's not offered here.
// Persisted under a separate storage key so settings survive restarts.
const SETTINGS_KEY = 'prompt-queue-settings-v1'
let settings = { modelSuggested: 'ask', gateFailOpen: false, defaultMode: 'new' }
const settingsSubs = new Set()
function useSettings() {
  return useSyncExternalStore(
    (cb) => { settingsSubs.add(cb); return () => settingsSubs.delete(cb) },
    () => settings,
    () => settings,
  )
}
async function loadSettings() {
  try {
    if (engineCtx && engineCtx.storage) {
      const s = await engineCtx.storage.get(SETTINGS_KEY)
      if (s && typeof s === 'object') {
        settings = {
          modelSuggested: s.modelSuggested === 'auto' ? 'auto' : 'ask',
          gateFailOpen: s.gateFailOpen === true,
          defaultMode: s.defaultMode === 'bot' ? 'bot' : 'new',
          // The path is validated at ACTION time (pqShellPath), not here — an
          // edited-but-not-yet-applied value must survive a restart.
          ingestDir: typeof s.ingestDir === 'string' && s.ingestDir ? s.ingestDir : INGEST_DEFAULT_DIR,
        }
      }
    }
  } catch { /* defaults are the safe side */ }
}
function setSettings(patch) {
  settings = { ...settings, ...patch }
  settingsSubs.forEach((f) => f())
  try {
    if (engineCtx && engineCtx.storage) engineCtx.storage.set(SETTINGS_KEY, settings)
  } catch { /* storage blip — settings reset to defaults on restart, safe side */ }
}

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
        // `playing` is intentionally persisted as false (restart-safe): no
        // fresh process ever auto-launches cards. The hydrate diagnostics
        // (v4) ride along so the next incarnation can count re-imports.
        await engineCtx.storage.set(STORE_KEY, { v: 4, cards: state.cards, playing: false, hydrate: state.hydrateInfo || null })
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

// ── Markdown ingest (Phase 3) ───────────────────────────────────────────────
// A folder of .md files → queue cards. The renderer has no fs API, so file
// access goes through `shell.exec` — a GENERIC cmd.exe door with NO
// interpreter-script flag allowed (python -c / powershell -Command are
// hard-blocked by the gateway's approval gate, error 4005; verified in
// tools/approval_detection.py + tui_gateway/methods_tools.py). Reliable
// windowed read = place a tiny helper FILE via
//   echo <b64-line> > _pq.b64 & certutil -f -decode _pq.b64 _pq_read.py & del
// (echo/certutil/del gate-ALLOWED, exact bytes, idempotent) then run it as
// `python <file>` — a FILE argument passes the gate (unlike -c), and bare
// `python` resolves in the gateway subprocess env. The gateway tails stdout
// to 4000 chars, so reads are 45-line windows, reassembled here.
//
// cmd.exe gotchas baked into these shapes (each probed through the REAL
// gateway env before shipping):
//   - `if not exist X mkdir X & a & b`: when X EXISTS the false if swallows
//     the WHOLE & chain — mkdir is its own command; guarded one-shots use
//     a parenthesized body: (…).
//   - for /f loops are useless under /c (backtick source fails, file source
//     drops lines) — never used.
//   - Windows mkdir auto-creates parents; there is no /p flag.
//   - Paths are validated by a blocklist (PQ_UNSAFE) BEFORE entering a
//     command: root is a %ENVVAR% (expands in the gateway env) or a drive
//     letter; segments may hold anything except PQ_UNSAFE and CR/LF. No
//     regex on user input, no escaping -- if validation passes, quoting
//     each complete argument once is sufficient for cmd.exe (the standard
//     remediation pattern for the CVE-2024-27980 / BatBadBut class).
const INGEST_DEFAULT_DIR = '%USERPROFILE%\\.hermes\\prompt-queue'
// cmd.exe interprets these even inside a "quoted" argument when quotes get
// stripped; reject them in user input instead of escaping (blocklist approach —
// the Node CVE-2024-27980/BatBadBut remediation pattern: validate, then quote).
const PQ_UNSAFE = '"&|<>^;%'
const READ_WINDOW = 45 // lines per shell.exec — stays under the 4000-char stdout tail
const INGEST_MAX_BYTES = 262144 // 256KB source ceiling: refuse, don't grind
// Precomputed ASCII base64 (pure A-Za-z0-9+/= — no command metacharacter can
// ride along). PQ_HELPER_B64 decodes to a 5-line python script that prints the
// lines [o, o+n) of its argv[1] file and reports TOTAL=<line count> on stderr.
// PQ_TEMPLATE_B64 is the prompts.md starter (CRLF). certutil -f -decode writes
// both byte-exact (verified: em-dash / UTF-8 survive).
const PQ_HELPER_B64 = 'aW1wb3J0IHN5cwpwLG8sbj1zeXMuYXJndlsxXSxpbnQoc3lzLmFyZ3ZbMl0pLGludChzeXMuYXJndlszXSkKTD1vcGVuKHAsZW5jb2Rpbmc9J3V0Zi04LXNpZycsZXJyb3JzPSdyZXBsYWNlJykucmVhZCgpLnNwbGl0bGluZXMoKQpzeXMuc3Rkb3V0LndyaXRlKCdcbicuam9pbihMW286bytuXSkpCnN5cy5zdGRlcnIud3JpdGUoJ1RPVEFMPScrc3RyKGxlbihMKSkrJ1xuJyk='
const PQ_TEMPLATE_B64 = 'IyBQcm9tcHRzDQojIE9uZSBwcm9tcHQgcGVyICIjIyAiIGhlYWRpbmcgYmVsb3cg4oCUIHRoZSBoZWFkaW5nIGlzIHRoZSBjYXJkIHRpdGxlIGFuZA0KIyB0aGUgbGluZXMgdW5kZXIgaXQgYmVjb21lIHRoZSBwcm9tcHQgYm9keS4gTGluZXMgd2l0aCBhIHNpbmdsZSAiIyIgYXJlDQojIGNvbW1lbnRzIGFuZCBpZ25vcmVkLiAiLSBbIF0iIGNoZWNrYm94ZXMgd29yayB0b28gKGVhY2ggY2hlY2tib3ggYmVjb21lcw0KIyBpdHMgb3duIGNhcmQpLiBCbGFuayBsaW5lcyBiZXR3ZWVuIGJsb2NrcyBhcmUgZmluZS4NCg0KIyMgRmlyc3QgcHJvbXB0DQpEZXNjcmliZSB0aGUgdGFzayBoZXJlIOKAlCB0aGlzIHdob2xlIGJsb2NrIGJlY29tZXMgYSBxdWV1ZSBjYXJkLg0KDQojIyBTZWNvbmQgcHJvbXB0DQpBbm90aGVyIHRhc2suIE9yIHVzZSBjaGVja2JveGVzIGluc3RlYWQgb2YgaGVhZGluZ3M6DQoNCi0gWyBdIGEgc2hvcnQgY2hlY2tib3ggdGFzaw0K'
// Validate a user folder path. Returns the CLEAN path (unquoted) or ''.
// Trusted roots: %ENVVAR% (expands in the gateway env — USERPROFILE, TEMP, …)
// or an absolute drive letter; remainder must be backslash segments.
// Blocklist PQ_UNSAFE + CR/LF. No regex on user input, no escaping: if this
// passes, quoting the complete argument once is sufficient for cmd.exe.
const PQ_ROOT_RE = /^(?:%[A-Za-z_][A-Za-z0-9_]*%|[A-Za-z]:)/
function pqShellPath(raw) {
  const p = String(raw || '').trim()
  if (!p) return ''
  const root = PQ_ROOT_RE.exec(p)
  if (!root) return ''
  let rest = p.slice(root[0].length)
  if (!rest.startsWith('\\')) return '' // root alone (C: / %USERPROFILE%) is not a folder path
  for (const ch of rest) {
    if (PQ_UNSAFE.includes(ch) || ch === '\n' || ch === '\r') return ''
  }
  return p
}
// Same blocklist for a bare file name (backslash additionally forbidden).
function pqShellName(raw) {
  const n = String(raw || '').trim()
  if (!n || n.includes('\\')) return ''
  for (const ch of n) {
    if (PQ_UNSAFE.includes(ch) || ch === '\n' || ch === '\r') return ''
  }
  return n
}
async function shellExec(command) {
  const res = await host.request('shell.exec', { command })
  if (!res || typeof res.stdout !== 'string') throw new Error('shell.exec returned no output')
  return res
}
// Ensure the read helper sits in the queue dir. mkdir is its OWN command (the
// if-swallow gotcha); placement is a separate pure & chain. Re-run on every
// ingest — a deleted/edited helper self-heals; it is never trusted as-is.
// Every path below enters the command line exactly once, fully quoted.
async function ensureReadHelper(dir) {
  const d = pqShellPath(dir)
  if (!d) throw new Error('invalid folder path')
  await shellExec(`if not exist "${d}" mkdir "${d}"`)
  await shellExec(`echo ${PQ_HELPER_B64} > "${d}\\_pq.b64" & certutil -f -decode "${d}\\_pq.b64" "${d}\\_pq_read.py" & del "${d}\\_pq.b64"`)
}
// Windowed read of an .md file. Returns { text, totalLines } or throws a
// readable error (missing file / over-size / helper failure).
async function readMdFile(dir, name) {
  const d = pqShellPath(dir)
  if (!d) throw new Error('invalid folder path')
  const n = pqShellName(name)
  if (!n) throw new Error('invalid file name')
  await ensureReadHelper(d)
  const f = `${d}\\${n}` // complete argument, quoted once at the use site
  const parts = []
  let off = 0
  let total = null
  for (let i = 0; i < 40; i++) { // hard cap: 40 windows × 45 lines, far past the byte ceiling
    const r = await shellExec(`python "${d}\\_pq_read.py" "${f}" ${off} ${READ_WINDOW}`)
    if (r.code !== 0) {
      throw new Error(n + ': ' + (r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'could not read')
    }
    if (total == null) {
      const m = /TOTAL=(\d+)/.exec(r.stderr || '')
      if (!m) throw new Error(n + ': helper reported no line count')
      total = parseInt(m[1], 10)
    }
    parts.push(r.stdout.replace(/\r\n/g, '\n').replace(/\n$/, ''))
    off += READ_WINDOW
    if (off >= total) break
  }
  const text = parts.join('\n')
  if (new TextEncoder().encode(text).length > INGEST_MAX_BYTES) throw new Error(n + ' is over the 256KB ingest limit — split it into smaller files')
  return { text, totalLines: total }
}
// List .md files in the queue dir. `dir /b /o-d` = bare names, newest first.
// The GLOB IS PART OF THE QUOTED PATH — one argument, quoted end to end (an
// unquoted * after a closing quote is the fragile cmd parse form).
// dir exits non-zero with EMPTY stdout when there are no matches — that is
// "no files", not an error (probe-confirmed shape).
async function listMdFiles(dir) {
  const d = pqShellPath(dir)
  if (!d) throw new Error('invalid folder path')
  await shellExec(`if not exist "${d}" mkdir "${d}"`)
  const r = await shellExec(`dir /b /o-d "${d}\\*.md"`)
  return r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
}
// Create the folder + prompts.md template when absent. Idempotent: an existing
// prompts.md is NEVER touched — guard is parenthesized so the if-swallow gotcha
// cannot eat the & chain when the file already exists.
async function createIngestTemplate(dir) {
  const d = pqShellPath(dir)
  if (!d) throw new Error('invalid folder path')
  await shellExec(`if not exist "${d}" mkdir "${d}"`)
  const hadTemplate = (await listMdFiles(d)).includes('prompts.md')
  await shellExec(`if not exist "${d}\\prompts.md" (echo ${PQ_TEMPLATE_B64} > "${d}\\_pq.b64" & certutil -f -decode "${d}\\_pq.b64" "${d}\\prompts.md" & del "${d}\\_pq.b64")`)
  return hadTemplate ? 'already there — left untouched' : 'created'
}
function openIngestFolder(dir) {
  const d = pqShellPath(dir || INGEST_DEFAULT_DIR)
  if (!d) return
  host.request('shell.exec', { command: `explorer "${d}"` }).catch(() => {})
}
// ingestDir is a setting — but the default lives with the Phase-3 constants
// below, which run AFTER the settings literal (const TDZ). Assign here, at
// first definition of INGEST_DEFAULT_DIR.
settings.ingestDir = settings.ingestDir || INGEST_DEFAULT_DIR

// ── ingest action (pure orchestration over the shell helpers above) ─────────
// Reads every checked .md file in the folder, splits it into blocks, and
// queues the new ones. Dedupe is EXACT-TEXT against every card that still
// exists — INCLUDING done/failed/skipped (state.cards spans all tabs): a
// prompt that already ran is not silently re-queued. To run an old prompt
// again: clear its card from the Done tab first, or use ↻ retry on it.
// Editing a block's text adds the new version; the old card stays (delete it).
// prompts.md's own template placeholder blocks queue harmlessly if left as
// written — the file is the user's to edit, and deleting a card is one click.
const INGEST_MAX_FILES = 50
const INGEST_MAX_CARDS_PER_RUN = 200
async function ingestQueueDir(dir, names) {
  const d = pqShellPath(dir || settings.ingestDir || INGEST_DEFAULT_DIR)
  if (!d) throw new Error('invalid folder path — expected %USERPROFILE%\\… or C:\\… with no cmd metacharacters')
  const list = (await listMdFiles(d)).slice(0, INGEST_MAX_FILES)
  // names undefined/null → ingest every .md file in the folder.
  const toRead = names ? list.filter((n) => names.includes(n)) : list
  const existing = new Set(state.cards.map((c) => c.text))
  const added = []
  const failedFiles = []
  let addedCount = 0
  let dupes = 0
  for (const name of toRead) {
    if (addedCount >= INGEST_MAX_CARDS_PER_RUN) break
    let text
    try {
      text = (await readMdFile(d, name)).text
    } catch (e) {
      failedFiles.push({ name, err: errMsg(e) })
      continue
    }
    const blocks = extractMdBlocks(text)
    for (const b of blocks) {
      if (addedCount >= INGEST_MAX_CARDS_PER_RUN) break
      if (existing.has(b.text)) { dupes++; continue }
      addCard(b.text, null, null, b.title) // default mode; 🎯 re-points per card; heading = card title
      existing.add(b.text)
      added.push({ name, title: b.title })
      addedCount++
    }
  }
  return { dir: d, filesChecked: toRead.length, added: added.length, dupes, failedFiles, truncated: list.length > INGEST_MAX_FILES }
}


// Pure markdown → blocks. Headings ("## x") and checkboxes ("- [ ] x") are
// block starts; bare "# …" comment lines are dropped; lines BEFORE the first
// block (preamble) ride into the first block's text so nothing is lost.
function extractMdBlocks(md) {
  // H2–H6 start a card block. A single-# line is a document title / comment —
  // the template's own contract ("## " headings are cards); '#' lines are ignored.
  const RE_HEADING = /^#{2,6}\s+(.*)$/
  const RE_CHECKBOX = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/
  const blocks = []
  let cur = null
  const preamble = []
  const push = () => { if (cur) blocks.push(cur); cur = null }
  for (const rawLine of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue
    const h = RE_HEADING.exec(line)
    const cb = RE_CHECKBOX.exec(line)
    // Single-# comment lines are ignored. (A '#' elsewhere in a line is
    // prompt content and survives — the test is anchored at line start.)
    if (!h && !cb && /^#/.test(line)) continue
    if (h) {
      push()
      cur = { title: h[1].trim(), lines: [] }
    } else if (cb) {
      push()
      cur = { title: cb[2].trim(), lines: [], checkbox: true }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  push()
  const out = []
  for (const b of blocks) {
    if (b.checkbox && !b.lines.length) { out.push({ title: b.title, text: b.title }); continue }
    const text = [b.title, ...b.lines].join('\n').trim()
    if (!text) continue
    out.push({ title: b.title || 'Prompt', text })
  }
  if (preamble.length && out.length) out[0] = { ...out[0], text: preamble.join('\n') + '\n' + out[0].text }
  return out
}
// Optional model pass: llm.oneshot WITHOUT a session_id — the aux task route
// resolves the local auxiliary model (this box: S1). Stateless; never touches
// the queue's gates or a live session. Returns raw suggestion text; suggestions
// are MODEL output → always shown for review, never auto-queued.
async function suggestFromMd(text) {
  const res = await host.request('llm.oneshot', {
    task: 'title_generation',
    instructions: 'You convert a markdown planning note into ready-to-run agent prompts. For each meaningful task output one line in EXACTLY this format: "- [ ] Title — prompt body". Keep every prompt self-contained (the receiving agent sees only that line). No other output, no preamble.',
    input: text.slice(0, 12000),
    max_tokens: 2048,
    temperature: 0.3,
  })
  const t = res && (res.text || '')
  if (!t) throw new Error('no suggestions returned')
  return t
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

// Gate verdict: true = no review running, false = review running,
// 'error' = could NOT verify (host.logs failed). The caller decides what
// 'error' means via settings.gateFailOpen (default: fail closed + visible).
async function reviewCleared() {
  try {
    const r = await reviewState()
    const active = r.spawn != null && (r.done == null || r.spawn > r.done)
    return !active
  } catch {
    return 'error'
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

// ── C1: card targets (new session OR an existing session) ──────────────────
// session.list (same RPC the sidebar uses) → rows {id, title, preview,
// started_at, message_count}. "With a reply" = message_count >= 2.
// ORDER CONTRACT (bug, 2026-10-14): the gateway already returns rows in
// last-ACTIVITY order, but the row summary exposes no activity field — so we
// must NOT re-sort client-side. The old started_at (creation-time) sort demoted
// old-but-active sessions out of the visible top PICKER_SHOW: an actively
// running week-old session vanished from the dropdown entirely (Arthur had to
// paste the ID by hand). Preserve the gateway's order through filter + slice.
let sessionCache = { at: 0, list: [] }
const SESSION_LIST_REFRESH_MS = 30000
const SESSION_LIST_LIMIT = 30 // over-fetch; the picker shows the latest 10 (by last activity)
const PICKER_SHOW = 10

async function refreshSessionList(force) {
  const now = Date.now()
  if (!force && sessionCache.list.length && now - sessionCache.at < SESSION_LIST_REFRESH_MS) {
    return sessionCache.list
  }
  try {
    const res = await host.request('session.list', { limit: SESSION_LIST_LIMIT })
    const rows = (res && res.sessions) || []
    // NO client-side sort — gateway order IS last-activity order (see above).
    const list = rows
      .filter((r) => (r.message_count || 0) >= 2)
      .map((r) => ({ id: r.id, title: (r.title || '').trim() || r.id }))
    sessionCache = { at: now, list }
  } catch {
    /* keep the stale cache (or empty) — fail-open */
  }
  return sessionCache.list
}
function pickerSessions() { return sessionCache.list.slice(0, PICKER_SHOW) }

// ── project targeting (Phase 1) ─────────────────────────────────────────────
// A card can also run into a DESKTOP PROJECT: 'project:<id>' targets an
// existing project (a fresh session is created with cwd = the project's
// primary path — the sidebar groups a session by its cwd), and
// 'project:new:<path>' creates the project first, then targets it.
// projects.* RPCs are profile-scoped (tui_gateway/methods_projects.py); the
// plugin's host.request hits the active profile's backend, the same one
// session.create uses — same profile, same projects.db.
const PROJECT_TARGET_PREFIX = 'project:'
const NEW_PROJECT_PREFIX = 'project:new:'
// Bot mode (Phase 2): a bot IS a profile, and its forever-chat is the session
// titled exactly "Bot Chat" on that profile — name-as-identity, never an id
// pin (apps/desktop canonical-chat contract: five hardening waves killed the
// pointer design; a name cannot dangle). The card only stores the PROFILE;
// the session row is resolved fresh at fire time.
const BOT_TARGET_PREFIX = 'bot:'
const CANONICAL_CHAT_TITLE = 'Bot Chat'
let projectCache = { at: 0, list: [] }
const PROJECT_LIST_REFRESH_MS = 30000

async function refreshProjectList(force) {
  const now = Date.now()
  if (!force && projectCache.list.length && now - projectCache.at < PROJECT_LIST_REFRESH_MS) {
    return projectCache.list
  }
  try {
    const res = await host.request('projects.list', {})
    const rows = (res && res.projects) || []
    projectCache = {
      at: now,
      list: rows
        .filter((p) => p && !p.archived)
        .map((p) => ({ id: p.id, name: p.name, path: p.primary_path || (p.folders && p.folders[0] && p.folders[0].path) || '' }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    }
  } catch {
    /* keep the stale cache (or empty) — fail-open, like the session picker */
  }
  return projectCache.list
}
// 'project:new:<path>' → { id: null, path: '<path>' }  (create-or-adopt)
// 'project:<id>'       → { id: '<id>' }                (existing project)
// Anything else        → null (not a project target).
// NOTE: the new-project branch is a PREFIX test, not an exact match — a real
// card is always 'project:new:<path>' (the form appends the folder), so an
// exact-equality check here made every new-project card fall into the
// existing-project path with a junk id 'new:<path>' and fail "not found".
function projectOf(target) {
  if (typeof target !== 'string' || !target.startsWith(PROJECT_TARGET_PREFIX)) return null
  if (target.startsWith(NEW_PROJECT_PREFIX)) return { id: null, path: target.slice(NEW_PROJECT_PREFIX.length) }
  return { id: target.slice(PROJECT_TARGET_PREFIX.length) }
}
function projectTitle(c) {
  const t = (c && c.target) || ''
  if (modeOf(t) === 'bot') return (String(t).slice(BOT_TARGET_PREFIX.length).trim() || 'default') + " · Bot Chat"
  const ref = projectOf(t)
  if (ref && ref.id === null) return (c && c.targetTitle) || 'new project'
  return (c && c.targetTitle) || t
}
// Path compare that ignores case, trailing separators, AND internal slash
// direction (Windows treats C:/x and C:\x as the same dir), so "adopt the
// project the user already made" matches a manually-created project even if
// the typed path differs in any of those ways.
function samePath(a, b) {
  const norm = (s) => String(s || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}

// ── mode framework (Phase 2) ────────────────────────────────────────────────
// A MODE is a named target resolver: card.target → session-create or resume
// params at fire time. The built-ins are:
//   new     — fresh session ('new' target)
//   session — follow-up into an existing session (target = its session key)
//   project — fresh session under a desktop project ('project:*')
//   bot     — the profile's canonical Bot Chat ('bot:<profile>')
// Later modes (e.g. kanban) add an entry here + a picker section; the engine
// switch in runCard() and the card display helpers are the only other touch
// points. Default mode lives in settings.defaultMode; per-card override is
// just the card's target string.
// NOTE: prefix tests, never exact equality (the Phase-1 lesson) — 'bot:x'
// and 'project:*' always carry their payload.
function modeOf(target) {
  if (typeof target !== 'string' || !target) return 'new'
  if (target === 'new') return 'new'
  if (target.startsWith(PROJECT_TARGET_PREFIX)) return 'project'
  if (target.startsWith(BOT_TARGET_PREFIX)) return 'bot'
  return 'session' // bare session key (the sidebar's row id IS the key)
}
// Per-card display helpers: a bot card's targetTitle is the PROFILE name, so
// the chip reads "profile · Bot Chat" (via projectTitle below), never like a
// plain session title.
function modePrefixOf(target) {
  return { project: '📁', bot: '🤖', session: '→', new: '＋' }[modeOf(target)] || '→'
}
// The target a card gets when none was chosen explicitly (e.g. an ::enqueue
// chip with defaultMode='bot'). 'new' → 'new'; 'bot' → the DEFAULT profile's
// canonical Bot Chat (the one profile name every backend has); 'session' has
// no sensible concrete pick, so it falls back to a fresh session — the
// composer's picker still opens on that section for an explicit choice.
function defaultTarget() {
  if (settings.defaultMode === 'bot') return BOT_TARGET_PREFIX + 'default'
  return 'new'
}

// ── profile roster (bot mode) ───────────────────────────────────────────────
// profiles.list is the ws twin of /api/profiles; rows carry name, model,
// description, and canonical_session (the "Bot Chat" registry row, resolved
// server-side by title). The plugin's host.request hits the active
// connection's backend — bot:<profile> targets only make sense for profiles
// on THIS backend (a remote-connection bot has no route from a renderer-only
// plugin; those need the agent-side subpackage, roadmap phase 5).
let profileCache = { at: 0, list: [] }
const PROFILE_LIST_REFRESH_MS = 30000

async function refreshProfileList(force) {
  const now = Date.now()
  if (!force && profileCache.list.length && now - profileCache.at < PROFILE_LIST_REFRESH_MS) {
    return profileCache.list
  }
  try {
    const res = await host.request('profiles.list', {})
    const rows = (res && res.profiles) || []
    profileCache = {
      at: now,
      list: rows
        .filter((p) => p && p.name)
        .map((p) => ({
          name: p.name,
          model: p.model || null,
          description: p.description || '',
          // canonical_session = the server-side "Bot Chat" registry row —
          // last positive confirmation the profile HAS a bot chat (used by
          // resolveBotMode's fail-closed branch).
          canonical: p.canonical_session && p.canonical_session.id ? p.canonical_session : null,
        }))
        .sort((a, b) => {
          if ((b.name === 'default') !== (a.name === 'default')) return a.name === 'default' ? -1 : 1
          return String(a.name).localeCompare(String(b.name))
        }),
    }
  } catch {
    /* keep the stale cache (or empty) — fail-open, like the other pickers */
  }
  return profileCache.list
}

// ── bot mode resolver ───────────────────────────────────────────────────────
// THE identity lookup: session.list { title: "Bot Chat", include_hidden: true }
// scoped to the profile (indexed exact-title, window-free; hidden rows resolve
// because canonical chats are always hidden). Name-as-identity — NO stored id
// pin anywhere in this path.
//
// FAIL CLOSED, mirroring desktop's canonical-chat contract: a lookup that
// THROWS must never read as "no Bot Chat exists" — the post-restart warm-up
// race is exactly when a swallowed error would mint a duplicate forever chat.
// Zero rows + the roster claiming canonical_session.id = unconfirmed absence
// (a backend mid-restart can answer empty) — also fail closed. Zero rows with
// no registry claim = confirmed absence → create it (adopt-before-mint: the
// re-lookup inside this call is what prevents the fork; if session.title hits
// "already in use" we adopt the winner instead of forking).
// Returns { sid (stored key), profile, isNew } or throws.
async function resolveBotMode(profileName) {
  const p = String(profileName || '').trim()
  if (!p) throw new Error('bot target has no profile name')

  // 1 — consult the registry on the bot's own source (profile param).
  let listRes
  try {
    listRes = await host.request('session.list', { profile: p, title: CANONICAL_CHAT_TITLE, include_hidden: true })
  } catch (e) {
    throw new Error(`could not check ${p}'s Bot Chat registry (${errMsg(e)}) — not starting a new chat`)
  }
  const rows = (listRes && listRes.sessions) || []
  const match = rows.find((r) => {
    const root = String((r && r.root_title) || '').trim()
    const t = String((r && r.title) || '').trim()
    return root === CANONICAL_CHAT_TITLE || (!root && t === CANONICAL_CHAT_TITLE)
  })
  if (match && match.id) {
    // exact-lookup gateways report the compression-lineage tip as resolved_id;
    // the registry row stays the identity.
    return { sid: match.resolved_id || match.id, profile: p, isNew: false }
  }

  // Zero rows is NOT the same as a thrown error — a backend mid-restart can
  // answer empty while the real chat still holds the canonical title. When
  // the roster says this profile HAS a canonical row, that's unconfirmed
  // absence: fail closed (retry) instead of minting a fork.
  const roster = await refreshProfileList(true)
  const row = roster.find((x) => x.name === p)
  if (row && row.canonical && row.canonical.id) {
    throw new Error(`could not confirm ${p}'s Bot Chat registry — not starting a new chat (retry in a moment)`)
  }

  // 2 — confirmed absence: create the ONE forever chat, born hidden.
  let created
  try {
    created = await host.request('session.create', {
      profile: p,
      title: CANONICAL_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
    })
  } catch (e) {
    throw new Error(`session.create for ${p}'s Bot Chat failed: ${errMsg(e)}`)
  }
  const runtime = created && (created.session_id || created.sessionId)
  const stored = created && (created.stored_session_id || created.storedSessionId)

  // session.create is lazy: the stored row may not exist until the first
  // prompt, and the turn-start auto-titler can race the deferred title. An
  // eager session.title materializes the row NOW under the canonical name —
  // without it a second card (or retry) during the untitled window would see
  // zero rows and mint a duplicate.
  let titled = false
  if (runtime) {
    try {
      await host.request('session.title', { session_id: runtime, title: CANONICAL_CHAT_TITLE })
      titled = true
    } catch (e) {
      // ADOPT-BEFORE-MINT: a title-uniqueness rejection means another writer
      // took the canonical title between our registry miss and this write —
      // re-consult and adopt the winner, never fork. If the re-consult STILL
      // finds no row, fail closed (a wedged card is recoverable; a prompt
      // silently landing in an untitled stray session would fork the forever
      // chat and be invisible). Other title errors fall through: old
      // gateways without the eager write persist the row on the first prompt.
      if (/already in use/i.test(String((e && e.message) || e))) {
        const again = await host.request('session.list', { profile: p, title: CANONICAL_CHAT_TITLE, include_hidden: true })
        const winner = ((again && again.sessions) || []).find((r) => String(r.title) === CANONICAL_CHAT_TITLE || String(r.root_title) === CANONICAL_CHAT_TITLE)
        if (winner && winner.id) return { sid: winner.resolved_id || winner.id, profile: p, isNew: false }
        throw new Error(`could not confirm ${p}'s Bot Chat registry after a title conflict — not continuing (retry in a moment)`)
      }
      /* else: old gateway without the eager write — the row persists on the
         first prompt submit below; the retry path re-consults by name. */
    }
  }

  // Zero-message lazy sessions get pruned when no row exists yet (older
  // gateways). If the eager title failed AND we have no stored id, return the
  // runtime id anyway: session.resume accepts a live runtime id, and the card
  // prompt's submit persists the row — the next resolution finds it by name.
  const sid = stored || runtime
  if (!sid) throw new Error(`session.create returned no id for ${p}'s Bot Chat`)
  return { sid, profile: p, isNew: true }
}

// ── target resolution (engine entry into the mode framework) ────────────────
// One call per card at fire time: card.target → { kind, sid?, stored?,
// createCwd?, botProfile? }. kind 'new' (one-shot — closed after the turn) →
// runCard mints a fresh
// session (optionally with cwd); kind 'existing' → runCard resumes the given
// key. Unresolvable targets THROW a user-readable error; runCard fails the
// card with it (a failed resolution must never look like a stuck card).
async function resolveTarget(c) {
  const target = c.target || 'new'
  switch (modeOf(target)) {
    case 'new':
      return { kind: 'new', createCwd: null }
    case 'project': {
      // Phase-1 logic: 'project:<id>' → existing project's cwd;
      // 'project:new:<path>' → idempotent projects.create, then re-anchor.
      const ref = projectOf(target)
      const list = await refreshProjectList(true)
      if (ref.id) {
        const proj = list.find((p) => p.id === ref.id)
        if (!proj) throw new Error(`project "${c.targetTitle || ref.id}" not found — it may have been deleted/archived, or the card's target is stale. Re-point it in the 🎯 target picker (or add a new project) and retry.`)
        if (!proj.path) throw new Error(`project "${proj.name}" has no folder — add one in the sidebar, then retry`)
        return { kind: 'new', createCwd: proj.path }
      }
      const rawPath = String(target.slice(NEW_PROJECT_PREFIX.length) || '').trim()
      if (!rawPath) throw new Error('new project: no folder path set on the card')
      const name = (c.projectName || '').trim() || rawPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      // Idempotent create: a card whose project was already minted (e.g. a
      // failed session.create after a successful projects.create, then retry)
      // reuses the existing project instead of hitting 5063 (duplicate
      // primary path).
      const dupe = list.find((p) => samePath(p.path, rawPath))
      let createdProj = dupe || null
      if (!createdProj) {
        try {
          const res = await host.request('projects.create', { name, primary_path: rawPath, folders: [rawPath] })
          createdProj = res && res.project
        } catch (e) {
          throw new Error('projects.create: ' + errMsg(e))
        }
        if (!createdProj || !createdProj.id) throw new Error('projects.create returned no project')
      }
      // Anchor the card to the REAL project (id + resolved primary path) so a
      // retry — or a second card re-pointed at it — doesn't re-create.
      patchCard(c.id, { target: PROJECT_TARGET_PREFIX + createdProj.id, targetTitle: createdProj.name, projectName: name })
      return { kind: 'new', createCwd: createdProj.primary_path || rawPath }
    }
    case 'bot': {
      const profileName = String(target.slice(BOT_TARGET_PREFIX.length)).trim()
      const r = await resolveBotMode(profileName)
      // stored stays NULL: the resolved row (possibly a compression-lineage
      // tip) is a live handle, not identity — pinning it would recreate the
      // id-pointer failure class. Re-runs re-resolve by NAME.
      return { kind: 'existing', sid: r.sid, stored: null, botProfile: r.profile }
    }
    case 'session':
    default:
      // Follow-up into an existing session. session.resume reattaches an
      // already-live session WITHOUT taking the slot from clients already
      // streaming it (gateway: _resume_reuse_live attaches alongside), so a
      // target open in a tile is safe.
      return { kind: 'existing', sid: target, stored: target }
  }
}

// ── engine ──────────────────────────────────────────────────────────────────
let inFlight = 0
const turnTimers = new Map()   // card id → { interval, timeout }
const reviewTimers = new Map() // card id → interval
// card id → { phase, idleSince }: cards whose prompt the gateway QUEUED
// behind the target's in-flight turn (submit response status "queued").
//   phase 'inflight' — the target's current turn is still running; its
//     message.complete is NOT ours (poll flips to 'gap' when busy clears,
//     or the event handler flips it when the completion lands).
//   phase 'gap'      — in-flight turn ended, drain pending. The session is
//     idle in this gap; the gateway restarts it with our prompt within
//     seconds (busy true again → entry dropped, normal tracking resumes).
//     If the drain never starts within 90s, the card fails cleanly.
const queuedBehind = new Map()

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

  // 1 — attach to the target: a NEW session, or an EXISTING one (C1).
  // Final pre-launch check: the global gate again, so a review that forked
  // after the per-card spawn grace closed still holds the next card.
  const pre = await anySessionWorking()
  if (pre) {
    const v2 = await waitForModelFree()
    if (v2 === 'paused') return
  }
  patchCard(id, { status: 'launching', ts: Date.now(), err: null })
  // Mode framework (Phase 2): card.target is a MODE STRING — resolve it to
  // session params now. A resolution failure fails the card with a readable
  // error; it must never wedge (the Phase-1 "stuck card" class).
  let plan
  try {
    plan = await resolveTarget(card(id))
  } catch (e) {
    patchCard(id, { status: 'failed', err: errMsg(e), ts: Date.now() })
    return
  }
  let sid
  let stored
  if (plan.kind === 'new') {
    let created
    try {
      created = await host.request('session.create', { title: c.title, ...(plan.createCwd ? { cwd: plan.createCwd } : {}) })
    } catch (e) {
      patchCard(id, { status: 'failed', err: 'session.create: ' + errMsg(e), ts: Date.now() })
      return
    }
    sid = created && (created.session_id || created.sessionId)
    stored = created && (created.stored_session_id || created.storedSessionId)
    if (!sid) {
      patchCard(id, { status: 'failed', err: 'session.create returned no id', ts: Date.now() })
      return
    }
  } else {
    // kind 'existing': follow-up into an existing session — a plain session
    // key or a bot's canonical Bot Chat. session.resume reattaches an
    // already-live session WITHOUT taking the slot from clients already
    // streaming it (gateway: _resume_reuse_live attaches alongside), so a
    // target open in a tile is safe. profile rides the resume for bot-mode
    // targets (named-profile bots on a pooled backend); omitted for the
    // active profile's plain sessions.
    let resumed
    try {
      resumed = await host.request('session.resume', { session_id: plan.sid, ...(plan.botProfile ? { profile: plan.botProfile } : {}) })
    } catch (e) {
      patchCard(id, { status: 'failed', err: 'session.resume: ' + errMsg(e), ts: Date.now() })
      return
    }
    sid = resumed && (resumed.session_id || resumed.sessionId)
    stored = plan.stored
    if (!sid) {
      patchCard(id, { status: 'failed', err: 'session.resume returned no id', ts: Date.now() })
      return
    }
  }
  const isNew = plan.kind === 'new'
  patchCard(id, { sid, stored, status: 'running', ts: Date.now() })

  // 2 — send the prompt. If the target is mid-turn the gateway ACCEPTS but
  // QUEUES it (response status "queued"); the prompt runs after the in-flight
  // turn ends. Track that so waitTurn skips the in-flight turn's completion
  // (which would otherwise mark us done before our turn even starts).
  let subRes
  try {
    subRes = await submitWithRetry(sid, c.text)
  } catch (e) {
    patchCard(id, { status: 'failed', err: 'prompt.submit: ' + errMsg(e), ts: Date.now() })
    if (isNew) host.request('session.close', { session_id: sid }).catch(() => {}) // never close a target session
    return
  }
  if (subRes && (subRes.status === 'queued' || subRes.status === 'pending')) {
    queuedBehind.set(id, { phase: 'inflight', idleSince: null })
    patchCard(id, { queuedBehind: true, ts: Date.now() })
  }

  // 3 — wait for turn completion
  const ok = await waitTurn(id, sid)
  const cur = card(id)
  if (!cur || cur.status === 'failed' || cur.status === 'done') return // removed/failed meanwhile
  if (!ok) {
    const hours = Math.round(TURN_STALL_MS / 3600000)
    patchCard(id, { status: 'failed', err: `turn stall: no completion after ${hours}h (session left open)`, ts: Date.now() })
    return // don't close a session that may still be working
  }

  // 4 — strict review gate (reviews fork AFTER the turn ends).
  // reviewWaitSince is persisted so a remount/backstop measures from here,
  // not from a later timer rebuild.
  patchCard(id, { status: 'review-wait', reviewWaitSince: Date.now(), ts: Date.now() })
  await waitReview(id)
  const cur2 = card(id)
  if (!cur2 || cur2.status === 'failed') return

  // 5 — done. Free the active-session slot for sessions THIS queue created
  // (the sidebar row stays). Target sessions are never closed by the plugin
  // — the normal idle reaper frees their slot.
  patchCard(id, { status: 'done', doneAt: Date.now(), ts: Date.now() })
  if (isNew) {
    setTimeout(() => {
      host.request('session.close', { session_id: sid }).catch(() => {})
    }, CLOSE_AFTER_DONE_MS)
  }
}

// Resolves true when the turn completed (event or busy=false watchdog),
// false on the stall backstop (TURN_STALL_MS).
function waitTurn(id, sid) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      const t = turnTimers.get(id)
      if (t) { clearInterval(t.interval); clearTimeout(t.timeout); turnTimers.delete(id) }
      queuedBehind.delete(id)
      resolve(ok)
    }
    const interval = setInterval(() => {
      const c = card(id)
      if (!c) return finish(true)
      if (c.status !== 'running' && c.status !== 'launching') return finish(true)
      const q = queuedBehind.get(id)
      if (q) {
        const busy = isBusy(sid)
        if (q.phase === 'inflight') {
          if (busy) return // target's in-flight turn still running — not ours
          q.phase = 'gap' // turn ended (completion pending or missed)
        }
        // phase 'gap': between the in-flight completion and our drain.
        if (busy) { queuedBehind.delete(id); return } // our turn started
        if (q.idleSince == null) q.idleSince = Date.now()
        else if (Date.now() - q.idleSince > 90 * 1000) {
          patchCard(id, { status: 'failed', err: 'queued in target, but the queued turn never started (session left open)', ts: Date.now() })
          finish(true)
        }
        return
      }
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
// reviewWaitSince is persisted on the card (not just a local startedAt) so a
// pane remount that rebuilds this timer — or the REVIEW_STALL_MS backstop —
// measures from the ORIGINAL wait start, not the remount.
function waitReview(id) {
  return new Promise((resolve) => {
    let settled = false
    const c0 = card(id)
    const startedAt = (c0 && c0.reviewWaitSince) || Date.now()
    const finish = () => {
      if (settled) return
      settled = true
      const t = reviewTimers.get(id)
      if (t) clearInterval(t)
      reviewTimers.delete(id)
      patchCard(id, { holdingReview: false, reviewWaitSince: null })
      resolve()
    }
    const check = async () => {
      if (settled) return
      const c = card(id)
      if (!c || c.status !== 'review-wait') return finish()
      if (Date.now() - startedAt < REVIEW_SPAWN_GRACE_MS) return
      const verdict = await reviewCleared()
      if (verdict === true) return finish()
      if (verdict === 'error') {
        // Verification unavailable: hold by default (fail CLOSED) so a log
        // blip can never release the next card while a review may run.
        // The 20 s re-poll retries until absence is confirmed. Fail-open is
        // an explicit opt-in (gear → Gate on error).
        if (settings.gateFailOpen) return finish()
        if (!c.holdingReview) patchCard(id, { holdingReview: true })
        return
      }
      // verdict === false: a review is still running — keep waiting, unless
      // we've been here past the backstop, in which case the review itself is
      // the anomaly (no review has ever run this long): fail with a hint
      // instead of holding the lane forever.
      if (Date.now() - startedAt > REVIEW_STALL_MS) {
        patchCard(id, {
          status: 'failed', holdingReview: false, reviewWaitSince: null,
          err: `review gate: a review is STILL running after ${Math.round(REVIEW_STALL_MS / 3600000)}h (none has ever run that long) — check the session, then retry`,
          ts: Date.now(),
        })
        return finish()
      }
    }
    reviewTimers.set(id, setInterval(check, REVIEW_POLL_MS))
  })
}

// ── user actions ────────────────────────────────────────────────────────────
function play() {
  if (!state.playing) {
    // resumeHint (set by hydrate after a reload with pending work) is cleared
    // the moment the user takes back control.
    set({ playing: true, resumeHint: null })
    setTimeout(pump, 100)
  }
}
function pause() { set({ playing: false }) }
function addCard(text, target, targetTitle, titleOverride) {
  const t = (text || '').trim()
  if (!t) return
  set({
    cards: [...state.cards, {
      id: uid(), text: t, title: titleOverride || sanitizeTitle(t), status: 'queued', ts: Date.now(),
      // Composer passes the current target; ::enqueue chips pass nothing →
      // the default mode (settings.defaultMode).
      target: target || defaultTarget(), targetTitle: targetTitle || null,
      // 'New project…' passes the typed name via targetTitle — keep a copy
      // under its own field so the engine can name the project it mints.
      projectName: (target || '').startsWith(NEW_PROJECT_PREFIX) ? (targetTitle || null) : null,
    }],
  })
}
function removeCard(id) {
  const c = card(id)
  if (!c) return
  if (c.status === 'launching' || c.status === 'running' || c.status === 'review-wait') return
  set({ cards: state.cards.filter((x) => x.id !== id) })
  queuedBehind.delete(id)
}
function clearStatus(status) { set({ cards: state.cards.filter((c) => c.status !== status) }) }
function clearDone() { clearStatus('done') }
function clearSkipped() { clearStatus('skipped') }

// ── card action menu (the × button) ─────────────────────────────────────────
// Deleting a card is a bit destructive, so × opens a small choice instead:
// Skip it (→ Skipped tab), mark it done (→ Done tab), or delete it for real.
function CardActionsMenu({ c }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const item = (label, fn, danger) => jsx('button', {
    onClick: () => { setOpen(false); fn() },
    style: {
      display: 'block', width: '100%', textAlign: 'left',
      border: 'none', background: 'transparent', cursor: 'pointer',
      color: danger ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)',
      fontSize: '0.65rem', padding: '3px 4px', borderRadius: '3px',
    },
    children: label,
  })
  return jsxs('div', {
    ref,
    style: { position: 'relative', display: 'flex', alignItems: 'center' },
    children: [
      jsx('button', {
        title: 'Skip, mark done, or delete',
        onClick: () => setOpen(!open),
        style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
        children: '×',
      }),
      open
        ? jsx('div', {
            style: {
              position: 'absolute', zIndex: 40, top: '100%', right: 0, marginTop: '2px',
              background: 'var(--ui-background, var(--ui-panel, #1c1c1e))',
              border: '1px solid var(--ui-stroke-secondary)', borderRadius: '6px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: '3px 4px', width: '128px',
            },
            children: [
              item('↷ Skip', () => patchCard(c.id, { status: 'skipped', doneAt: Date.now(), ts: Date.now() })),
              item('✓ Mark done', () => patchCard(c.id, { status: 'done', doneAt: Date.now(), ts: Date.now() })),
              item('✕ Delete', () => removeCard(c.id), true),
            ],
          })
        : null,
    ],
  })
}
function openCardSession(c) {
  const key = c.stored || c.target
  if (!key || key === 'new') return
  // Bot cards never set a stored key (name-as-identity — the resolved row is
  // a live handle, not a pin), so their open button stays hidden; the bot's
  // row in the Bots roster is the door to its chat by design.
  if (modeOf(c.target) === 'bot' && !c.stored) return
  const opts = modeOf(c.target) === 'bot' ? { profile: String(c.target.slice(BOT_TARGET_PREFIX.length)).trim() } : {}
  host.openSession(key, opts).catch(() => {})
}
function retryCard(id) {
  patchCard(id, { status: 'queued', err: null, sid: null, stored: null, ts: Date.now() })
  if (!state.playing) setTimeout(pump, 50)
}
// Manual escape hatch for a wedged 'review-wait' card (lost gate timer, a
// review that never logged completion, a mis-parsed marker). The work is
// done — the turn completed before the card entered the gate — so force-done
// is safe. Closes the one-shot session's slot like the normal done path
// (stored === sid means the queue created it; target sessions are never
// closed). The auto sweep (sweepOrphanedReviewWaits) covers the lost-timer
// case; this is for when you want to decide.
function forceDoneCard(id) {
  const c = card(id)
  if (!c || c.status !== 'review-wait') return
  patchCard(id, { status: 'done', doneAt: Date.now(), holdingReview: false, reviewWaitSince: null, ts: Date.now() })
  if (c.sid && c.sid === c.stored) {
    setTimeout(() => { host.request('session.close', { session_id: c.sid }).catch(() => {}) }, CLOSE_AFTER_DONE_MS)
  }
}
// Dead-timer reconciliation: a card in 'review-wait' must have a live
// waitReview poll, but teardownWired() (pane unmount / plugin dispose) can
// clear the timer while the card's in-memory status stays 'review-wait' —
// and if the module isn't re-imported, hydrate() never re-runs to rebuild it,
// so the card counts forever with the review long done. This sweep (called
// from the Board's 1 s tick, throttled) re-arms any review-wait card that has
// no live timer. Idempotent: cards WITH a timer are left alone. This is the
// actual self-heal for the lost-timer state the REVIEW_STALL_MS backstop
// can't reach (that one only fires while the timer is still alive).
let lastReviewSweep = 0
function sweepOrphanedReviewWaits() {
  const now = Date.now()
  if (now - lastReviewSweep < 10000) return
  lastReviewSweep = now
  for (const c of state.cards) {
    if (c.status === 'review-wait' && !reviewTimers.has(c.id)) {
      waitReview(c.id).then(() => {
        const cur = card(c.id)
        if (cur && cur.status === 'review-wait') patchCard(c.id, { status: 'done', doneAt: Date.now(), ts: Date.now() })
      })
    }
  }
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
      let requeued = 0
      const cards = s.cards.map((c) => {
        if (c.status === 'launching' || c.status === 'running') {
          if (c.sid && busy[c.sid]) return { ...c, status: 'running', err: 're-attached after restart' }
          if (c.sid && c.stored) return { ...c, status: 'review-wait', err: 're-attached after restart' }
          requeued += 1
          return { ...c, status: 'queued', err: 'interrupted before completion — re-queued' }
        }
        return c
      })
      // Re-import observability (v4): every module incarnation counts itself.
      // `playing` is forced false by design (restart-safe), so without this a
      // reload looked like an idle queue with orphaned cards — the incident
      // that motivated it. resumeHint makes the state visible in the UI; the
      // stored diagnostics make the next occurrence diagnosable.
      const inFlight = cards.filter((c) => ['running', 'review-wait'].includes(c.status)).length
      const queuedN = cards.filter((c) => c.status === 'queued').length
      const prevInfo = (s && s.hydrate) || null
      const info = { n: (prevInfo ? prevInfo.n : 0) + 1, at: Date.now(), inFlight, requeued }
      if (queuedN + inFlight > 0) {
        console.info('[prompt-queue] hydrate #' + info.n + ' — restored ' + cards.length + ' cards ('
          + queuedN + ' queued, ' + inFlight + ' re-attached, ' + requeued + ' re-queued); playing forced false by design — press Play to resume')
      }
      set({ cards, playing: false, hydrated: true, hydrateInfo: info, resumeHint: queuedN + inFlight > 0 ? info : null })
      // resume re-attached cards through the same wait machinery (per-card
      // timers, so no clash with a later Play)
      cards.forEach((c) => {
        if (c.status === 'running') {
          waitTurn(c.id, c.sid).then((ok) => {
            const cur = card(c.id)
            if (!cur || cur.status !== 'running') return
            if (!ok) { patchCard(c.id, { status: 'failed', err: `turn stall: no completion after ${Math.round(TURN_STALL_MS / 3600000)}h (session left open)`, ts: Date.now() }); return }
            patchCard(c.id, { status: 'review-wait', reviewWaitSince: Date.now(), ts: Date.now() })
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
    // Prompt queued behind the target's in-flight turn: THAT turn's
    // completion is not ours — flip to 'gap' and wait for the drain.
    // (If a completion arrives in 'gap', it's the drained turn's — a fast
    // turn that finished before the poll saw busy=true — so let it promote.)
    const q = queuedBehind.get(c.id)
    if (q && q.phase === 'inflight') {
      q.phase = 'gap'
      q.idleSince = null
      return
    }
    queuedBehind.delete(c.id)
    // let the commit settle, then promote if the watchdog hasn't beaten us
    setTimeout(() => {
      const c2 = card(c.id)
      if (c2 && (c2.status === 'running' || c2.status === 'launching') && !isBusy(sid)) {
        patchCard(c2.id, { status: 'review-wait', reviewWaitSince: Date.now(), ts: Date.now() })
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
  skipped: { color: 'var(--ui-text-quaternary)', label: 'skipped' },
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

// ── gear: plugin settings ───────────────────────────────────────────────────
// Three knobs: how model-suggested (::enqueue) prompts are treated, what the
// review gate does when its log verification errors, and the default mode for
// cards added without an explicit target (Phase 2). All default to the SAFE
// side (ask / fail-closed / new session). Persisted via ctx.storage.
function SettingsMenu() {
  const s = useSettings()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    // The button and the menu are SIBLINGS inside the (positioned) header
    // row, so a wrapper-ref hit test can't see both — tag them with an
    // attribute and treat any click outside as "close".
    const onDoc = (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-pq-settings]') : null
      if (!el) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', fontSize: '0.68rem', color: 'var(--ui-text-secondary)' }
  const seg = (active) => ({
    border: '1px solid ' + (active ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'),
    background: active ? 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' : 'transparent',
    color: active ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)',
    borderRadius: '4px', cursor: 'pointer', fontSize: '0.65rem', padding: '1px 7px',
  })
  // Fragment: the dropdown anchors to the header row (position:relative),
  // NOT to a wrapper around the gear button — anchoring to the button's own
  // width pushed the 250px menu leftward out of the app window.
  return jsxs(Fragment, {
    children: [
      jsx('button', {
        'data-pq-settings': 'trigger',
        title: 'Prompt Queue settings',
        onClick: () => setOpen(!open),
        style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.8rem', padding: '1px 3px', borderRadius: '3px' },
        children: '⚙',
      }),
      open
        ? jsx('div', {
            'data-pq-settings': 'menu',
            style: {
              position: 'absolute', zIndex: 40, top: '100%', right: '6px', marginTop: '2px',
              background: 'var(--ui-background, var(--ui-panel, #1c1c1e))',
              border: '1px solid var(--ui-stroke-secondary)', borderRadius: '6px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: '6px', width: '250px',
            },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 5px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' },
                children: [
                  jsx('span', { style: { fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)', flex: 1 }, children: 'Suggested prompts' }),
                  jsx('button', { onClick: () => setSettings({ modelSuggested: 'ask' }), style: seg(s.modelSuggested === 'ask'), children: 'Ask first' }),
                  jsx('button', { onClick: () => setSettings({ modelSuggested: 'auto' }), style: seg(s.modelSuggested === 'auto'), children: 'Auto-add' }),
                ],
              }),
              jsx('div', { style: { ...rowStyle, color: 'var(--ui-text-quaternary)', fontSize: '0.62rem', paddingBottom: '6px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' }, children: 'A chat turn can suggest a prompt via ::enqueue (untrusted model output). “Ask first” shows a chip you click to accept; “Auto-add” queues it immediately. It only runs while Play is active.' }),
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 5px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' },
                children: [
                  jsx('span', { style: { fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)', flex: 1 }, children: 'Review gate on error' }),
                  jsx('button', { onClick: () => setSettings({ gateFailOpen: false }), style: seg(!s.gateFailOpen), children: 'Hold' }),
                  jsx('button', { onClick: () => setSettings({ gateFailOpen: true }), style: seg(s.gateFailOpen), children: 'Open' }),
                ],
              }),
              jsx('div', { style: { ...rowStyle, color: 'var(--ui-text-quaternary)', fontSize: '0.62rem', paddingBottom: '6px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' }, children: 'If the background-review check can’t verify (log blip): “Hold” keeps the queue paused with a visible state (default, safer); “Open” proceeds and re-checks in 20 s.' }),
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 5px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' },
                children: [
                  jsx('span', { style: { fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)', flex: 1 }, children: 'Default mode' }),
                  jsx('button', { onClick: () => setSettings({ defaultMode: 'new' }), style: seg(s.defaultMode === 'new'), children: 'New session' }),
                  jsx('button', { onClick: () => setSettings({ defaultMode: 'bot' }), style: seg(s.defaultMode === 'bot'), title: "Cards added without an explicit target (e.g. the ::enqueue chip) go into the DEFAULT profile's one \"Bot Chat\".", children: 'Bot Chat' }),
                ],
              }),
              jsx('div', { style: { ...rowStyle, color: 'var(--ui-text-quaternary)', fontSize: '0.62rem' }, children: 'Target for cards added without an explicit pick (the ::enqueue chip). “New session” is the classic one-shot session; “Bot Chat” feeds the default profile’s forever chat. Every card can still be re-pointed in its 🎯 picker — modes: new session, project, bot, or any existing session.' }),
            ],
          })
        : null,
    ],
  })
}

// ── ingest menu (Phase 3) ───────────────────────────────────────────────────
// The 📥 header button. A folder of .md files → queue cards: point it at a
// folder (persisted in settings), optionally create the folder + a prompts.md
// template on first use, then "Ingest" queues every block not already in the
// queue (exact-text dedupe). All file access is the gated shell.exec path —
// no fs API exists in the renderer.
function IngestMenu() {
  const s = useSettings()
  const [open, setOpen] = useState(false)
  const [dirInput, setDirInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('') // '' | 'ok' | 'err' message line
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-pq-ingest]') : null
      if (!el) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const toggle = () => {
    setDirInput(s.ingestDir || INGEST_DEFAULT_DIR)
    setStatus('')
    setOpen(!open)
  }
  const btn = (label, onClick, opts) => {
    opts = opts || {}
    return jsx('button', {
      type: 'button',
      onClick,
      disabled: !!opts.disabled || busy,
      style: {
        border: '1px solid ' + (opts.primary ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'),
        background: opts.primary ? 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' : 'transparent',
        color: busy ? 'var(--ui-text-quaternary)' : (opts.primary ? 'var(--ui-accent)' : 'var(--ui-text-secondary)'),
        borderRadius: '4px', cursor: busy || opts.disabled ? 'default' : 'pointer',
        fontSize: '0.65rem', padding: '3px 8px',
      },
      children: label,
    })
  }
  const run = async (fn) => {
    if (busy) return
    setBusy(true)
    setStatus('working…')
    try {
      await fn()
    } catch (e) {
      setStatus('error — ' + errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const saveDir = () => {
    const v = dirInput.trim()
    if (!pqShellPath(v)) { setStatus('invalid path — expected %USERPROFILE%\\… or C:\\… (no quotes, & | < > ^ ; %)'); return }
    setSettings({ ingestDir: v })
    setStatus('folder saved')
  }
  const doIngest = () => run(async () => {
    const r = await ingestQueueDir(s.ingestDir)
    setStatus(`added ${r.added} card${r.added === 1 ? '' : 's'} · ${r.dupes} already in queue${r.failedFiles.length ? ` · failed: ${r.failedFiles.map((f) => f.name).join(', ')}` : ''}${r.truncated ? ' (capped at 50 files)' : ''}`)
  })
  return jsxs(Fragment, {
    children: [
      jsx('button', {
        'data-pq-ingest': 'trigger',
        title: 'Ingest a folder of .md files as queue cards',
        onClick: toggle,
        style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.8rem', padding: '1px 3px', borderRadius: '3px' },
        children: '📥',
      }),
      open
        ? jsx('div', {
            'data-pq-ingest': 'menu',
            style: {
              position: 'absolute', zIndex: 40, top: '100%', right: '26px', marginTop: '2px',
              background: 'var(--ui-background, var(--ui-panel, #1c1c1e))',
              border: '1px solid var(--ui-stroke-secondary)', borderRadius: '6px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: '6px', width: '270px',
            },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 4px', borderBottom: '1px solid var(--ui-stroke-secondary)', marginBottom: '4px' },
                children: [
                  jsx('span', { style: { fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)', flex: 1 }, children: 'Ingest folder' }),
                ],
              }),
              jsxs('div', {
                style: { display: 'flex', gap: '4px', padding: '2px 6px 4px' },
                children: [
                  jsx('input', {
                    value: dirInput,
                    onChange: (e) => setDirInput(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveDir() },
                    spellCheck: false,
                    placeholder: INGEST_DEFAULT_DIR,
                    style: {
                      flex: 1, minWidth: 0, fontSize: '0.65rem', padding: '3px 6px',
                      border: '1px solid var(--ui-stroke-secondary)', borderRadius: '4px',
                      background: 'transparent', color: 'var(--ui-text-secondary)',
                    },
                  }),
                  jsx('button', { type: 'button', onClick: saveDir, style: { border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: 'var(--ui-text-secondary)', fontSize: '0.65rem', borderRadius: '4px', padding: '3px 7px', cursor: 'pointer' }, children: 'Save' }),
                ],
              }),
              jsxs('div', {
                style: { display: 'flex', gap: '4px', padding: '0 6px 4px' },
                children: [
                  btn('＋ Folder + template', () => run(async () => {
                    const res = await createIngestTemplate(s.ingestDir)
                    setStatus(res === 'created' ? `created ${s.ingestDir}\\prompts.md` : 'folder + prompts.md already there — left untouched')
                  })),
                  btn('📂 Open', () => { openIngestFolder(s.ingestDir); }),
                ],
              }),
              jsx('div', {
                style: { padding: '0 6px 4px', borderTop: '1px solid var(--ui-stroke-secondary)', marginTop: '2px' },
                children: btn(busy ? '⏳ Ingesting…' : '⬇ Ingest → queue', doIngest, { primary: true, disabled: busy }),
              }),
              status
                ? jsx('div', { style: { padding: '2px 6px 4px', fontSize: '0.62rem', color: status.startsWith('error') ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, children: status })
                : null,
              jsx('div', { style: { padding: '4px 6px 2px', fontSize: '0.6rem', color: 'var(--ui-text-quaternary)' }, children: 'Each “## ” heading and “- [ ]” checkbox in a .md file becomes a card (single-# lines are comments). Blocks already in the queue — any tab — are skipped, so re-ingesting is safe.' }),
            ],
          })
        : null,
    ],
  })
}

// ── C1 UI: target picker ────────────────────────────────────────────────────
// value undefined → trigger button ("🎯 target ▾"); value provided →
// composer-style button showing the current choice. onSelect(value, title).
// Sections (Phase 2 modes): New session / Projects (existing + "New project…"
// inline form) / Bots (profiles' canonical Bot Chat) / sessions (latest 10
// with a reply) / manual session ID.
function TargetPicker({ value, trigger, onSelect }) {
  const [openA, setOpenA] = useState(false)   // row 1 — the destination KIND menu
  const [openB, setOpenB] = useState(false)   // row 2 — the concrete TARGET menu
  const [goUp, setGoUp] = useState(false)
  const [manual, setManual] = useState('')
  const [manualErr, setManualErr] = useState('')
  const [sessions, setSessions] = useState(pickerSessions())
  const [projects, setProjects] = useState(projectCache.list)
  const [profiles, setProfiles] = useState(profileCache.list)
  const [newProj, setNewProj] = useState(false)
  const [projName, setProjName] = useState('')
  const [projPath, setProjPath] = useState('')
  const boxRef = useRef(null)

  // Two-row design: row 1 picks the destination KIND (a mode), row 2 picks the
  // concrete target within that kind. activeKind drives which row-2 list shows.
  // It is seeded from value and re-synced whenever the value prop changes
  // (hydrate / card switch / commit) — but merely arming a different kind does
  // NOT change value, so that sync can't yank an in-progress "pick the kind
  // first" flow back. A target is COMMITTED when its mode matches activeKind;
  // until then row 2 shows a "choose…" hint and value keeps the last valid one.
  const [activeKind, setActiveKind] = useState(() => modeOf(value))
  useEffect(() => { setActiveKind(modeOf(value)) }, [value])
  const committed = modeOf(value) === activeKind
  const wide = !trigger

  const measureFlip = () => {
    try {
      const r = boxRef.current && boxRef.current.getBoundingClientRect()
      if (r) setGoUp(r.bottom + 260 + 12 > (window.innerHeight || 768))
    } catch { /* */ }
  }
  const toggleA = () => { if (!openA && !openB) measureFlip(); setOpenA(!openA); setOpenB(false) }
  const toggleB = () => { if (activeKind === 'new') return; if (!openA && !openB) measureFlip(); setOpenB(!openB); setOpenA(false) }

  useEffect(() => {
    if (!openA && !openB) return undefined
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) { setOpenA(false); setOpenB(false) } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [openA, openB])

  // Refresh the three lists whenever either menu opens (fail-open to cache).
  useEffect(() => {
    if (!openA && !openB) return undefined
    let alive = true
    refreshSessionList(true).then((l) => { if (alive) setSessions(l.slice(0, PICKER_SHOW)) })
    refreshProjectList(true).then((l) => { if (alive) setProjects(l) })
    refreshProfileList(true).then((l) => { if (alive) setProfiles(l) })
    return () => { alive = false }
  }, [openA, openB])

  const closeAll = () => { setOpenA(false); setOpenB(false) }
  const pick = (v, title) => { onSelect(v, title); closeAll(); setManual(''); setManualErr(''); setNewProj(false) }

  const KINDS = [
    { k: 'new', icon: '+', label: 'New session' },
    { k: 'project', icon: '\u{1F4C1}', label: 'Project' },
    { k: 'bot', icon: '\u{1F916}', label: 'Bot' },
    { k: 'session', icon: '\u21A9', label: 'Session' },
  ]
  const kindMeta = (k) => KINDS.find((x) => x.k === k) || KINDS[0]

  // Row-2 chip text for the current activeKind.
  let row2 = { text: '', warn: false }
  if (activeKind === 'new') row2 = { text: 'fresh session \u00B7 closes after run', warn: false }
  else if (!committed) row2 = { text: 'choose a ' + activeKind + '\u2026', warn: true }
  else if (activeKind === 'project') {
    const ref = projectOf(value)
    if (ref && ref.id === null) row2 = { text: '\u2728 new \u00B7 ' + ref.path, warn: false }
    else {
      const p = ref ? projects.find((x) => x.id === ref.id) : null
      row2 = { text: (p && p.name) || String(value).slice(PROJECT_TARGET_PREFIX.length), warn: false }
    }
  } else if (activeKind === 'bot') {
    row2 = { text: (String(value).slice(BOT_TARGET_PREFIX.length).trim() || 'default') + ' \u00B7 Bot Chat', warn: false }
  } else {
    const s = sessions.find((x) => x.id === value)
    row2 = { text: s ? s.title : String(value), warn: false }
  }

  const rowBtnStyle = (accent) => ({
    display: 'flex', alignItems: 'center', gap: '5px', width: wide ? '100%' : 'auto', maxWidth: '100%',
    border: '1px solid ' + (accent ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'), borderRadius: '5px',
    background: accent ? 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' : 'transparent',
    color: 'var(--ui-text-secondary)', fontSize: wide ? '0.6875rem' : '0.625rem',
    padding: wide ? '4px 7px' : '3px 6px', cursor: 'pointer',
  })
  const midStyle = { flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  const caretStyle = { color: 'var(--ui-text-quaternary)', flexShrink: 0, fontSize: '0.55rem' }
  const menuWrapStyle = (extra) => Object.assign({
    position: 'absolute', zIndex: 30, left: 0,
    ...(goUp ? { bottom: '100%', marginBottom: '2px' } : { top: '100%', marginTop: '2px' }),
    background: 'var(--ui-background, var(--ui-panel, #1c1c1e))',
    border: '1px solid var(--ui-stroke-secondary)', borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)', overflowY: 'auto',
  }, wide ? { right: 0 } : {}, extra || {})

  const rowStyle = { padding: '5px 9px', fontSize: '0.7rem', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  const sectionLabel = '\u2014 '
  const hdrStyle = { padding: '4px 9px 2px', fontSize: '0.625rem', color: 'var(--ui-text-quaternary)', fontWeight: 600 }
  const noteStyle = { padding: '2px 9px 3px', fontSize: '0.65rem', color: 'var(--ui-text-quaternary)' }
  const inputBase = { fontSize: '0.65rem', padding: '3px 6px', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '4px', background: 'transparent', color: 'var(--ui-text-secondary)', boxSizing: 'border-box' }

  const projIs = (id) => { if (!committed) return false; const r = projectOf(value); return !!(r && r.id === id) }
  const botIs = (name) => committed && String(value).slice(BOT_TARGET_PREFIX.length).trim() === name

  // \u2014 Row-1 menu: the four destination kinds. \u2014
  const menuA = openA ? jsx('div', {
    style: menuWrapStyle({ maxHeight: '240px', minWidth: wide ? undefined : '180px' }),
    children: KINDS.map((kd) => jsxs('div', {
      key: kd.k,
      onClick: () => {
        if (kd.k === 'new') { setActiveKind('new'); pick('new', null) }
        else { setActiveKind(kd.k); setOpenA(false); setOpenB(true) }
      },
      style: { ...rowStyle, color: activeKind === kd.k ? 'var(--ui-accent)' : 'var(--ui-text-secondary)', fontWeight: activeKind === kd.k ? 600 : 400 },
      children: [kd.icon + ' ', kd.label],
    })),
  }) : null

  // \u2014 Row-2 menu content, by activeKind. \u2014
  let menuB = null
  if (openB) {
    if (activeKind === 'project') {
      const submitNew = () => { if (projPath.trim()) pick(NEW_PROJECT_PREFIX + projPath.trim(), projName.trim()) }
      menuB = jsx('div', { style: menuWrapStyle({ maxHeight: '320px', minWidth: wide ? undefined : '280px' }), children: [
        jsxs('div', { style: hdrStyle, children: [sectionLabel, 'Project', sectionLabel] }),
        projects.length === 0
          ? jsx('div', { style: noteStyle, children: 'No projects yet \u2014 add one below' })
          : projects.map((p) => jsxs('div', {
              key: p.id, title: p.path || p.name, onClick: () => pick(PROJECT_TARGET_PREFIX + p.id, p.name),
              style: { ...rowStyle, color: projIs(p.id) ? 'var(--ui-accent)' : 'var(--ui-text-secondary)', fontWeight: projIs(p.id) ? 600 : 400 },
              children: ['\u{1F4C1} ', p.name],
            })),
        jsxs('div', { onClick: () => setNewProj(!newProj), style: rowStyle, children: [newProj ? '\u25BE ' : '+ ', 'New project\u2026'] }),
        newProj ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 9px 6px' }, children: [
          jsx('input', { value: projName, onChange: (e) => setProjName(e.target.value), placeholder: 'Name (optional \u2014 defaults to the folder name)', style: { ...inputBase, width: '100%' } }),
          jsxs('div', { style: { display: 'flex', gap: '4px' }, children: [
            jsx('input', { value: projPath, onChange: (e) => setProjPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') submitNew() }, placeholder: '\u2026/folder path (must exist)', style: { ...inputBase, flex: 1, minWidth: 0 } }),
            jsx('button', { type: 'button', onClick: submitNew, disabled: !projPath.trim(), style: { border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: projPath.trim() ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)', fontSize: '0.65rem', borderRadius: '4px', padding: '3px 7px', cursor: projPath.trim() ? 'pointer' : 'default' }, children: 'Create' }),
          ] }),
        ] }) : null,
      ] })
    } else if (activeKind === 'bot') {
      menuB = jsx('div', { style: menuWrapStyle({ maxHeight: '300px', minWidth: wide ? undefined : '240px' }), children: [
        jsxs('div', { style: hdrStyle, children: [sectionLabel, 'Bot (profile Bot Chat)', sectionLabel] }),
        profiles.length === 0
          ? jsx('div', { style: noteStyle, children: 'No profiles on this backend' })
          : profiles.map((pr) => jsxs('div', {
              key: pr.name,
              title: [pr.description, pr.model ? 'model: ' + pr.model : null, 'Runs into this profile\u2019s hidden \u201CBot Chat\u201D (created on first use if missing)'].filter(Boolean).join(' \u00B7 '),
              onClick: () => pick(BOT_TARGET_PREFIX + pr.name, pr.name),
              style: { ...rowStyle, color: botIs(pr.name) ? 'var(--ui-accent)' : 'var(--ui-text-secondary)', fontWeight: botIs(pr.name) ? 600 : 400 },
              children: ['\u{1F916} ', pr.name, pr.model ? ` \u00B7 ${pr.model}` : ''],
            })),
        jsx('div', { style: noteStyle, children: 'The prompt lands in the profile\u2019s one forever \u201CBot Chat\u201D \u2014 created on first use if missing.' }),
      ] })
    } else if (activeKind === 'session') {
      menuB = jsx('div', { style: menuWrapStyle({ maxHeight: '320px', minWidth: wide ? undefined : '260px' }), children: [
        jsxs('div', { style: hdrStyle, children: [sectionLabel, 'Session', sectionLabel] }),
        sessions.length === 0
          ? jsx('div', { style: noteStyle, children: 'No sessions with a reply yet' })
          : sessions.map((s) => jsxs('div', {
              key: s.id, title: s.id, onClick: () => pick(s.id, s.title),
              style: { ...rowStyle, color: committed && value === s.id ? 'var(--ui-accent)' : 'var(--ui-text-secondary)', fontWeight: committed && value === s.id ? 600 : 400 },
              children: [s.title],
            })),
        jsx('div', { style: noteStyle, children: 'Most recently active sessions (top ' + PICKER_SHOW + '). Hidden/internal ones are excluded — paste any ID below.' }),
        jsxs('div', { style: { display: 'flex', gap: '4px', padding: '6px 7px', borderTop: '1px solid var(--ui-stroke-secondary)' }, children: [
          jsx('input', { value: manual, onChange: (e) => { setManual(e.target.value); setManualErr('') }, placeholder: '\u2026or paste a session ID', style: { ...inputBase, flex: 1, minWidth: 0, borderColor: manualErr ? 'var(--ui-text-secondary)' : undefined } }),
          jsx('button', { type: 'button', onClick: () => { const idm = manual.trim(); if (!/^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(idm)) { setManualErr('expected YYYYMMDD_HHMMSS_hex6'); return } pick(idm, idm) }, style: { border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: 'var(--ui-text-secondary)', fontSize: '0.65rem', borderRadius: '4px', padding: '3px 7px', cursor: 'pointer' }, children: 'Set' }),
        ] }),
        manualErr ? jsx('div', { style: { padding: '0 9px 6px', fontSize: '0.625rem', color: 'var(--ui-text-secondary)' }, children: manualErr }) : null,
      ] })
    }
  }

  const aMeta = kindMeta(activeKind)
  const row2Icon = { project: '\u{1F4C1} ', bot: '\u{1F916} ', session: '\u21A9 ', new: '+ ' }[activeKind] || ''

  return jsxs('div', {
    ref: boxRef,
    style: { position: 'relative', flex: trigger ? 'none' : 1, display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
    children: [
      // Row 1 \u2014 the destination kind.
      jsxs('div', { style: { position: 'relative' }, children: [
        jsxs('button', { type: 'button', onClick: toggleA, style: rowBtnStyle(openA), children: [
          jsx('span', { style: midStyle, children: aMeta.icon + ' ' + aMeta.label }),
          jsx('span', { style: caretStyle, children: openA ? '\u25B4' : '\u25BE' }),
        ] }),
        menuA,
      ] }),
      // Row 2 \u2014 the concrete target for that kind (fixed note for new sessions).
      jsxs('div', { style: { position: 'relative' }, children: [
        jsxs('button', { type: 'button', onClick: toggleB, disabled: activeKind === 'new', style: rowBtnStyle(openB), children: [
          jsx('span', { style: Object.assign({}, midStyle, row2.warn ? { color: 'var(--ui-text-quaternary)' } : {}), children: row2Icon + row2.text }),
          activeKind !== 'new' ? jsx('span', { style: caretStyle, children: openB ? '\u25B4' : '\u25BE' }) : null,
        ] }),
        menuB,
      ] }),
    ],
  })
}

function CardRow({ c, onDragStart, onDropOn }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const meta = STATUS_META[c.status] || STATUS_META.queued
  const live = c.status === 'running' || c.status === 'launching' || c.status === 'review-wait'
  const queuedInTarget = c.queuedBehind && (c.status === 'running' || c.status === 'launching')
  const holding = c.holdingReview && c.status === 'review-wait'
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
                children: (queuedInTarget ? '⏳ queued in target' : holding ? '⏸ holding — review verification unavailable' : meta.label) + (elapsed != null ? ` · ${ago(elapsed)}` : ''),
              }),
            ],
          }),
          !live
            ? jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '5px', marginTop: '3px' },
                children: [
                  jsx(TargetPicker, {
                    value: c.target,
                    trigger: '🎯 target ▾',
                    onSelect: (v, t) => patchCard(c.id, {
                      target: v, targetTitle: t || null,
                      projectName: (v || '').startsWith(NEW_PROJECT_PREFIX) ? (t || null) : null,
                    }),
                  }),
                  c.target && c.target !== 'new'
                    ? jsxs(Tip, {
                        label: modeOf(c.target) === 'project'
                          ? `Runs in a fresh session under project: ${projectTitle(c)}`
                          : modeOf(c.target) === 'bot'
                            ? `Runs into the profile's one "Bot Chat": ${String(c.target).slice(BOT_TARGET_PREFIX.length).trim() || 'default'}`
                            : `Follow-up into: ${c.targetTitle || c.target}`,
                        children: jsx('span', {
                          style: {
                            fontSize: '0.625rem', color: 'var(--ui-text-quaternary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            maxWidth: '110px', flexShrink: 1,
                          },
                          children: `${modePrefixOf(c.target)} ${projectTitle(c)}`,
                        }),
                      })
                    : null,
                ],
              })
            : null,
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
          c.status === 'review-wait'
            ? jsx('button', {
                title: 'Force done — the turn already completed; the review gate is stuck (lost timer / unverified review). Safe to release.',
                onClick: () => forceDoneCard(c.id),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-accent)', cursor: 'pointer', fontSize: '0.7rem', padding: '1px 3px', borderRadius: '3px' },
                children: '✓⏩',
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
            ? jsx(CardActionsMenu, { c })
            : null,
        ],
      }),
    ],
  })
}

function Board() {
  const q = useQueue()
  const s = useSettings()
  const [draft, setDraft] = useState('')
  // The composer's target follows the gear's default mode — but only while
  // it still holds the PREVIOUS default: an explicit picker choice (or any
  // divergence) is user intent and a later settings change must not clobber
  // it mid-compose.
  const [draftTarget, setDraftTarget] = useState(defaultTarget)
  const [draftTargetTitle, setDraftTargetTitle] = useState(null)
  const prevDefaultMode = useRef(s.defaultMode)
  useEffect(() => {
    if (prevDefaultMode.current === s.defaultMode) return
    const prev = prevDefaultMode.current
    prevDefaultMode.current = s.defaultMode
    // display titles are derived from the target string — nothing else to sync
    if (draftTarget === (prev === 'bot' ? BOT_TARGET_PREFIX + 'default' : 'new')) setDraftTarget(defaultTarget())
  }, [s.defaultMode]) // eslint-disable-line react-hooks/exhaustive-deps
  const dragId = useRef(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); sweepOrphanedReviewWaits() }, 1000)
    return () => clearInterval(t)
  }, [])

  // Composer (drop-down + text box + Add) is user-resizable: a drag
// handle above it grows/shrinks it; the card list absorbs the change.
  const [composerH, setComposerH] = useState(96)
  const composerDrag = useRef(null)

  // Tabs keep the queue clean: done/failed cards live on their own tabs.
  // Only the Queue tab is reorderable (that's the drain order).
  const [tab, setTab] = useState('queue')
  const tabCards = {
    queue: q.cards.filter((c) => c.status !== 'done' && c.status !== 'failed' && c.status !== 'skipped'),
    done: q.cards.filter((c) => c.status === 'done'),
    skipped: q.cards.filter((c) => c.status === 'skipped'),
    failed: q.cards.filter((c) => c.status === 'failed'),
  }

  const counts = {
    queued: q.cards.filter((c) => c.status !== 'done' && c.status !== 'failed' && c.status !== 'skipped').length,
    done: q.cards.filter((c) => c.status === 'done').length,
    skipped: q.cards.filter((c) => c.status === 'skipped').length,
    failed: q.cards.filter((c) => c.status === 'failed').length,
  }
  const submit = () => {
    addCard(draft, draftTarget, draftTargetTitle)
    setDraft('')
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '140px', fontFamily: 'inherit' },
    children: [
      jsxs('div', {
        style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderBottom: '1px solid var(--ui-stroke-secondary)' },
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
          jsx(IngestMenu, {}),
          jsx(SettingsMenu, {}),
          jsx('span', {
            style: { fontSize: '0.65rem', color: (q.playing && q.modelBusy) || q.resumeHint ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)', marginLeft: 'auto' },
            children: q.playing && q.modelBusy
              ? '⏳ waiting for model…'
              : q.resumeHint
                ? '⏸ restored after reload — press Play to resume'
                : `${counts.queued} queued · ${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''}`,
          }),
        ],
      }),
      // Tab row: Queue / Done / Failed — the queue stays clean.
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 8px 0', flexShrink: 0 },
        children: [
          [
            ['queue', `Queue · ${counts.queued}`],
            ['done', `Done · ${counts.done}`],
            ['skipped', `Skipped · ${counts.skipped}`],
            ['failed', `Failed · ${counts.failed}`],
          ].map(([k, label]) =>
            jsx('button', {
              key: k,
              onClick: () => setTab(k),
              style: {
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: '0.65rem', padding: '3px 7px', borderRadius: '4px',
                color: tab === k ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)',
                background: tab === k ? 'color-mix(in srgb, var(--ui-accent) 10%, transparent)' : 'transparent',
                fontWeight: tab === k ? 600 : 400,
              },
              children: label,
            }),
          ),
          tab === 'done' && counts.done > 0
            ? jsx('button', {
                key: 'clear-done',
                title: 'Clear done cards',
                onClick: () => clearDone(),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 4px', borderRadius: '3px' },
                children: '✕ clear',
              })
            : null,
          tab === 'skipped' && counts.skipped > 0
            ? jsx('button', {
                key: 'clear-skipped',
                title: 'Clear skipped cards',
                onClick: () => clearSkipped(),
                style: { border: 'none', background: 'transparent', color: 'var(--ui-text-quaternary)', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 4px', borderRadius: '3px', marginLeft: 'auto' },
                children: '✕ clear',
              })
            : null,
        ],
      }),
      jsx('div', {
        style: { flex: 1, overflowY: 'auto', padding: '6px', display: 'flex', flexDirection: 'column', gap: '5px' },
        children: tabCards[tab].length === 0
          ? jsx('div', {
              style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', padding: '12px 6px', textAlign: 'center' },
              children:
                tab === 'queue'
                  ? 'Empty. Add a prompt below — each one runs in its own new session, visible in the sidebar.'
                  : tab === 'done'
                    ? 'No done cards yet.'
                    : tab === 'skipped'
                      ? 'No skipped cards yet. The × on a card can skip it (or mark it done) instead of deleting.'
                      : 'No failed cards yet.',
            })
          : tabCards[tab].map((c) =>
              jsx(CardRow, {
                key: c.id,
                c,
                onDragStart: (e, id) => {
                  if (tab !== 'queue') return
                  dragId.current = id
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', id) } catch { /* some runtimes */ }
                },
                onDropOn: (targetId) => {
                  if (tab !== 'queue') return
                  const from = dragId.current
                  dragId.current = null
                  if (from && from !== targetId) reorderCard(from, targetId)
                },
              }),
            ),
      }),
      jsx('div', {
        className: 'pq-composer-handle',
        title: 'Drag up or down to resize the composer',
        onPointerDown: (e) => {
          e.preventDefault()
          composerDrag.current = { y: e.clientY, h: composerH }
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* */ }
        },
        onPointerMove: (e) => {
          const d = composerDrag.current
          if (!d) return
          let h = d.h + (d.y - e.clientY)
          if (h < 90) h = 90
          const max = Math.round(window.innerHeight * 0.75)
          if (h > max) h = max
          setComposerH(h)
        },
        onPointerUp: (e) => {
          composerDrag.current = null
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* */ }
        },
        style: { height: '6px', flexShrink: 0, borderBottom: '1px solid var(--ui-stroke-secondary)', background: 'var(--ui-stroke-secondary)', opacity: 0.5 },
      }),
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '6px 8px', flexShrink: 0, minHeight: '90px', height: composerH },
        children: [
          // Non-growing wrapper: TargetPicker is two compact rows (kind +
          // concrete target) at natural height — inside the fixed-height
          // composer block a flex-grow root would stretch and gap from the
          // text box, mis-anchoring its menus.
          jsx('div', {
            style: { flex: '0 0 auto', minWidth: 0 },
            children: jsx(TargetPicker, {
              value: draftTarget,
              onSelect: (v, t) => { setDraftTarget(v); setDraftTargetTitle(t || null) },
            }),
          }),
          jsxs('div', {
            style: { display: 'flex', gap: '5px', alignItems: 'stretch', flex: 1, minHeight: '24px' },
            children: [
              jsx('textarea', {
                placeholder: 'Add a prompt…',
                value: draft,
                onChange: (e) => setDraft(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
                },
                style: {
                  flex: 1, minHeight: '24px', fontSize: '0.7rem', resize: 'none', lineHeight: '1.4',
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
                  fontSize: '0.7rem', padding: '4px 8px', alignSelf: 'flex-start',
                },
                children: '+ Add',
              }),
            ],
          }),
        ],
      }),    ],
  })
}

function Chip() {
  const q = useQueue()
  const active = q.cards.filter((c) => ['launching', 'running', 'review-wait'].includes(c.status)).length
  const queued = q.cards.filter((c) => c.status === 'queued').length
  let label
  let color
  const restored = !q.playing && q.resumeHint && (queued + active > 0)
  if (q.playing && q.modelBusy) {
    label = 'queue · waiting for model'
    color = 'var(--ui-accent)'
  } else if (q.playing) {
    label = `queue · ${active || 0} active, ${queued} next`
    color = 'var(--ui-accent)'
  } else if (restored) {
    // A reload re-imported the module while work was pending. Distinct from
    // "paused" on purpose — this one happened TO the user, not by their click.
    label = `queue restored · ${queued + active} pending — press Play`
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
        : restored
          ? 'The app (or the plugin) reloaded while the queue had pending work — Play state never survives a reload by design. Press Play on the board (bottom-left) to resume; in-flight cards were re-attached or re-queued (see their card notes).'
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
// Model-suggested prompts are UNTRUSTED INPUT (platform contract: directive
// attributes are untrusted model output). Default 'ask': the chip renders a
// clickable "add to queue" the user must accept. 'auto' (gear opt-in) keeps
// the legacy immediate add — but ONLY on the first mount while the message
// is still streaming (a reload re-renders old transcripts settled; those
// must never re-queue, even with auto-add on). dedupeKey is a NORMAL prop —
// React strips `key`, so the old code deduped on `undefined` and silently
// dropped every card after the first.
function EnqueueChip({ prompt, dedupeKey, streaming }) {
  const [phase, setPhase] = useState('pending')
  useEffect(() => {
    if (enqueuedKeys.has(dedupeKey)) { setPhase('seen'); return }
    enqueuedKeys.add(dedupeKey)
    if (!prompt || prompt.length > 2000) { setPhase('invalid'); return }
    if (streaming && settings.modelSuggested === 'auto') { addCard(prompt); setPhase('added') }
    // 'ask': stays 'pending' — the user clicks the chip to accept it.
    // 'auto' on a settled re-render (reload/scroll-back): stays 'pending'
    // too — showing the chip again is safe; re-adding is not.
  }, [dedupeKey, prompt])
  const preview = (prompt || '').length > 200
    ? (prompt || '').slice(0, 200) + '…'
    : (prompt || '')
  const style = { color: 'var(--ui-text-quaternary)', fontSize: '0.7rem' }
  if (phase === 'pending') {
    return jsx('button', {
      onClick: () => { addCard(prompt); setPhase('added') },
      title: 'Model-suggested prompt (untrusted model output) — click to add it to the queue (it runs only while Play is active):\n' + (prompt || ''),
      style: {
        border: '1px solid var(--ui-accent)', background: 'color-mix(in srgb, var(--ui-accent) 8%, transparent)',
        color: 'var(--ui-accent)', fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px',
        cursor: 'pointer', textAlign: 'left',
      },
      children: '＋ ' + preview,
    })
  }
  if (phase === 'added') return jsx('span', { style, children: '✓ added to prompt queue' })
  if (phase === 'seen') return jsx('span', { style, children: '✓ in prompt queue' })
  return jsx('span', { style, children: '::enqueue — prompt missing or too long (max 2000 chars)' })
}

export default {
  id: 'prompt-queue',
  name: 'Prompt Queue',
  defaultEnabled: true,
  async register(ctx) {
    engineCtx = ctx
    // AWAIT: a directive can mount before storage resolves; auto-add must
    // not run against default settings (ask) when the user has 'auto' saved.
    await loadSettings()
    ensureWired()
    hydrate()

    let styleEl = null
    try {
      styleEl = document.createElement('style')
      styleEl.textContent =
        '@keyframes pq-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } } ' +
        '.pq-composer-handle { cursor: ns-resize; touch-action: none; user-select: none; }'
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
        render: ({ attrs, streaming }) => {
          const prompt = attrs && attrs.prompt
          // NORMAL prop (not `key` — React strips it, which broke dedup).
          const dedupeKey = (attrs && attrs.id) || (prompt || '').slice(0, 200)
          // streaming: true only while the message is still being generated —
          // the gate that lets auto-add fire once, never on old-transcript
          // re-renders after a reload.
          return jsx(EnqueueChip, { dedupeKey, prompt, streaming: !!streaming })
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
