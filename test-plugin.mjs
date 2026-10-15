// prompt-queue smoke/regression suite.
//
// Loads the REAL desktop/plugin.js in a node:vm module graph with faked
// @hermes/plugin-sdk / react (same harness pattern as bg-review-watch), then
// drives the actual gate + hydration functions through the __test export —
// no re-implementation of logic under test.
//
// Run:  node --experimental-vm-modules test-plugin.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./desktop/plugin.js', import.meta.url), 'utf8')

// ── synthetic log lines (agent.log format, local time) ──────────────────────
const M = 60 * 1000
const H = 60 * M
const pad = (n, w = 2) => String(n).padStart(w, '0')
const logTs = msAgo => {
  const d = new Date(Date.now() - msAgo)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},500`
}
const REVIEW_SPAWN = ago =>
  `${logTs(ago)} INFO run_agent: OpenAI client created (agent_init, shared=True) thread=bg-review:42424 provider=custom base_url=http://127.0.0.1:8080/v1 model=Qwen38-27b-q8`
const REVIEW_DONE = ago =>
  `${logTs(ago)} INFO agent.run_agent: Background review complete result=patched`
const COMP_START = ago =>
  `${logTs(ago)} INFO agent.conversation_compression: context compression started: session=test_sess messages=210 tokens=~199,555 model=Qwen38-27b-q8 focus=None`
const COMP_DONE = ago =>
  `${logTs(ago)} INFO agent.conversation_compression: context compression done: session=test_sess messages=210->12 rough_tokens=~45000 awaiting_real_usage=true`

let reviewLines = [] // fake 'bg-review' search results
let compLines = [] // fake 'context compression' search results
let sessionRows = [] // fake session.list rows

const eventHandlers = new Map()
const host = {
  logs: async ({ search }) => ({
    lines:
      search === 'bg-review' ? reviewLines
      : search === 'context compression' ? compLines
      : [],
  }),
  request: async (method) =>
    method === 'session.list' ? { sessions: sessionRows }
    : method === 'session.active_list' ? { sessions: [] }
    : {},
  onEvent(type, fn) {
    eventHandlers.set(type, fn)
    return () => eventHandlers.delete(type)
  },
  state: { busyBySession: { get: () => ({}) } },
}

function synthetic(exports) {
  const names = Object.keys(exports)
  return new vm.SyntheticModule(names, function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  })
}

const modules = new Map([
  ['@hermes/plugin-sdk', synthetic({
    host,
    Tip: (props) => ({ type: 'Tip', props }),
    STATUSBAR_AREAS: { right: 'statusBar.right' },
    TRANSCRIPT_DIRECTIVE_AREA: 'transcript.directive',
  })],
  ['react/jsx-runtime', synthetic({
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  })],
  ['react', synthetic({
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
  })],
])

const pluginModule = new vm.SourceTextModule(source, { identifier: 'prompt-queue/desktop/plugin.js' })
await pluginModule.link((specifier) => {
  const linked = modules.get(specifier)
  assert.ok(linked, `unexpected import: ${specifier}`)
  return linked
})
await pluginModule.evaluate()

const ns = pluginModule.namespace
const plugin = ns.default
assert.equal(plugin.id, 'prompt-queue')
assert.equal(plugin.defaultEnabled, true)
const t = ns.__test
assert.equal(typeof t.reviewCleared, 'function', '__test.reviewCleared exported')
assert.equal(typeof t.freshCompaction, 'function', '__test.freshCompaction exported')
assert.equal(typeof t.refreshSessionList, 'function', '__test.refreshSessionList exported')

// register against a fake ctx (storage + contributions); register is async.
const stored = new Map()
let dispose = () => {}
let contributions = []
await plugin.register({
  storage: {
    get: (k) => Promise.resolve(stored.has(k) ? stored.get(k) : null),
    set: (k, v) => { stored.set(k, v); return Promise.resolve() },
  },
  register: (c) => { contributions.push(c); return () => {} },
  onDispose: (cb) => { dispose = cb },
})
await new Promise((r) => setTimeout(r, 100)) // let wiring settle

assert.deepEqual(
  contributions.map((c) => c.id).sort(),
  ['chip', 'enqueue', 'pane'].sort(),
  'pane + status chip + enqueue directive registered')

// ── 1. review gate verdicts (v1.4.3 orphan semantics + healthy paths) ───────
reviewLines = [REVIEW_SPAWN(4 * H)] // orphan: no terminal line, older than REVIEW_STALL_MS (3h)
assert.equal(await t.reviewCleared(), true, 'orphan spawn (>3h, no terminal) releases the lane')

reviewLines = [REVIEW_SPAWN(1 * H)] // fresh spawn, live review in flight
assert.equal(await t.reviewCleared(), false, 'fresh spawn (1h, no terminal) holds the lane')

reviewLines = [REVIEW_SPAWN(2.9 * H)]
assert.equal(await t.reviewCleared(), false, 'boundary 2.9h — still holds')
reviewLines = [REVIEW_SPAWN(3.1 * H)]
assert.equal(await t.reviewCleared(), true, 'boundary 3.1h — releases (orphan)')

reviewLines = [REVIEW_SPAWN(30 * M), REVIEW_DONE(25 * M)]
assert.equal(await t.reviewCleared(), true, 'healthy run (terminal after spawn) clears')

// ── 2. compaction gate verdicts (v1.4.4) ─────────────────────────────────────
compLines = [COMP_START(10 * M)]
assert.equal((await t.freshCompaction()).active, true, 'healthy mid-run compaction holds')

compLines = [COMP_START(59 * M)]
assert.equal((await t.freshCompaction()).active, true, 'boundary 59m — still holds')

compLines = [COMP_START(61 * M)]
assert.equal((await t.freshCompaction()).active, false, 'boundary 61m — orphan ceiling releases')

compLines = [COMP_START(2 * H)]
assert.equal((await t.freshCompaction()).active, false, 'orphan start (2h, no terminal) releases')

compLines = [COMP_START(20 * M), COMP_DONE(15 * M)]
assert.equal((await t.freshCompaction()).active, false, 'committed run clears')

// ── 3. picker order contract (v1.4.1 regression: NO client-side re-sort) ─────
// The gateway returns session.list in LAST-ACTIVITY order; the row summary has
// no activity field, so a started_at sort (the old bug) demoted an active
// week-old session out of the visible picker. Order must pass through.
sessionRows = [
  { id: 's-older-active', title: 'Old but active', preview: 'x', started_at: '2026-10-01T09:00:00Z', message_count: 5 },
  { id: 's-newer', title: 'Newer session', preview: 'y', started_at: '2026-10-14T09:00:00Z', message_count: 3 },
  { id: 's-no-reply', title: 'No reply yet', preview: 'z', started_at: '2026-10-15T09:00:00Z', message_count: 1 },
]
const list = await t.refreshSessionList(true)
assert.deepEqual(
  list.map((r) => r.id),
  ['s-older-active', 's-newer'],
  'gateway (last-activity) order preserved; no-reply rows filtered')

// ── 4. hydration: v3 payload (no `hydrate` field) survives a reload ─────────
// A v3 payload predates re-import diagnostics; absence must be treated as the
// first incarnation, playing forced false, and a running card with no live
// session re-queued (never dropped).
t.getState().hydrated = false // allow one more hydrate() for the test
stored.set('prompt-queue-state-v1', {
  v: 3,
  cards: [{ id: 'c1', text: 'p', title: 'p', status: 'running', ts: 1 }],
  playing: true,
})
await t.hydrate()
const st = t.getState()
assert.equal(st.hydrated, true)
assert.equal(st.playing, false, 'playing is forced false on reload (restart-safe)')
assert.equal(st.cards.length, 1)
assert.equal(st.cards[0].status, 'queued', 'orphaned running card re-queues, never drops')
assert.match(st.cards[0].err || '', /re-queued/)
assert.ok(st.resumeHint && st.resumeHint.n === 1, 'resume hint visible with incarnation count')

dispose()
console.log('prompt-queue v1.4.4 smoke test passed (review gate 5, compaction gate 5, picker order 1, hydration 4)')
process.exit(0)
