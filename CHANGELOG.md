# Changelog

Behavioral history for the `prompt-queue` desktop plugin, oldest feature-set
first. Dates are release dates on this repo's history.

## Unreleased (on `unreleased` branch, since 2026-10-01)

Diagnosed against a real incident: a card targeting a research session
(`20260925_131637_57043f`) failed with `turn stall: no completion after 1h`
while the target's turn legitimately ran **3 h 22 m** (gateway
`agent.log`: prompt accepted 02:27:39, `Turn ended … duration=12116.2s` at
05:49:35). The card's prompt also "appeared late" in the target window.

### Fixed

- **False "turn stall" failures on long local-model turns.** The per-card
  stall backstop was hardcoded to 1 h, calibrated for cloud-model turns.
  Against local-model turns that routinely run 1–4 h on this box, it marked
  healthy cards `failed` after an hour while the turn was still working (the
  later real `message.complete` was ignored because the card was already
  failed). The backstop is now **12 h** — still a last-resort tripwire for
  genuinely hung sessions; real completions are caught by
  `message.complete` + the 10 s busy poll, exactly as before. The failure
  message now derives from the constant (`…after 12h…`).
- **Cards queued behind a busy target now track the right turn.** When the
  target is mid-turn, the gateway **accepts** the prompt but **queues** it
  behind the in-flight turn (response `status: "queued"`; the prompt only
  runs once the in-flight turn ends — this is why a queued prompt "appears
  late" in the target window). Previously the in-flight turn's
  `message.complete` would resolve the card as done **before the queued
  prompt's own turn had even started**. Now the card:
  - shows a live **`⏳ queued in target`** status (with elapsed time), so the
    wait is visible instead of silent;
  - ignores the in-flight turn's completion and the idle gap after it, and
    only completes when the drained turn's own `message.complete` lands (a
    10 s busy poll covers a fast drained turn that finishes before the poll
    sees `busy` again);
  - fails cleanly (`queued in target, but the queued turn never started`) if
    the drain never starts within 90 s.

### Unchanged

- **The global model-slot gate still holds cards while any session works** —
  including your own chat. A card targeting a session that is idle but whose
  *model* is busy in another session waits at the gate (status bar:
  `queue · waiting for model`) before it submits; that wait is expected, not
  a hang.
- Target sessions are still never closed by the plugin.

### UI

- **Resizable composer.** The bottom block (target drop-down + text box +
  `+ Add`) now has a drag handle above it: drag up to enlarge the text box
  (min ~90px, max 75% of the window height) for planning longer prompts; the
  card list above shrinks/expands to match.
- **Queue / Done / Failed tabs.** A tab row now sits above the card list;
  `done` and `failed` cards live on their own tabs so the **Queue** tab stays
  clean (live counts in the labels: `Queue · 3`, `Done · 12`, `Failed · 1`).
  The old header `✕ done` moved to the Done tab as `✕ clear`. Only the Queue
  tab is drag-reorderable (that's the drain order); Done/Failed cards keep
  their usual retry/remove/open-session controls.
- **Session picker opens up when it would run off the bottom of the window.**
  `TargetPicker` now measures the trigger against the viewport on open and
  flips the menu upward when opening downward would pass the window bottom
  (was: always down, or hardcoded-up for the composer). The composer picker
  — at the pane's bottom — therefore opens up; a card's picker near the top
  still opens down.

### Migration

- None needed. The new `queuedBehind` card flag is additive; saved queues
  from earlier versions load unchanged.

### Planned (addressing the [AtlasOmnia PR #7 review](https://github.com/AtlasOmnia/community-plugins/pull/7))

Three findings from the blocking review are being fixed on this branch, with
decisions locked (2026-10-02):

- **`::enqueue` — ask before queue (default).** Transcript-directive
  attributes are untrusted model output by platform contract
  (`apps/desktop/src/lib/transcript-directives.ts`). The directive will add
  a *pending* card the user clicks to accept; auto-add becomes an opt-in in
  the pane-header gear. Also fixes the dedup bug (React strips `key`, so the
  dedupe key was `undefined` — every second directive was silently dropped).
- **Review gate — fail-closed default.** On `host.logs` verification
  failure the gate will HOLD (visible "review verification unavailable"
  state, auto-retrying) instead of releasing the next card; fail-open is
  kept as an explicit opt-in. README/CHANGELOG "strict review gate"
  wording is being aligned with actual semantics.
- **Gear (pane header).** Settings: model-suggested prompts
  (ask / auto-queue), gate behavior (fail-closed / fail-open), persisted
  via `ctx.storage`.

Docs shipped ahead of the code (Phase 0, 2026-10-02): README **Trust &
Autonomy** and **Performance notes (local models)** sections — including the
KV-cache session-switch cost of one-session-per-card on local models.

## 2026-09-26 — Card targets: follow-ups into existing sessions (C1)

Cards can now run **into an existing session** instead of always creating a
new one.

### Added

- **Per-card target picker** — each card carries a `target`:
  - `New session` (default; identical behavior to v1), or
  - an existing session, picked from the **latest 10 sessions with a reply**
    (`session.list`, `message_count ≥ 2`, same RPC the sidebar uses), or
  - **pasted session ID** — the picker's "…or paste a session ID" field
    accepts the ID you copy from the desktop app
    (format `YYYYMMDD_HHMMSS_hex6`, format-checked before use).
- Target is settable in two places:
  - at **add time** — a picker row above the composer in the board pane;
  - **per card** — a `🎯 target ▾` trigger on every queued card, with a small
    `→ title` chip showing the current target. You can repoint a queued card
    any time before it fires (the picker is per-card, not only at add time).
- The ↗ (open session) button on a target card opens **that** session.

### Behavior changes

- A target card attaches via `session.resume` (the gateway reattaches an
  already-live session *alongside* clients that already have it open — a
  target open in a tile is not hijacked) and the prompt is submitted there.
- **Target sessions are never closed by the plugin.** The plugin only releases
  the active-session slot of sessions it created itself; a target session's
  slot is freed by the normal idle reaper, as with any session you use.
- The global model-slot gate (below) also protects target cards: if the
  target session is mid-turn when its card is reached, the queue holds.

### Verified against the 2026-09 gateway source

- `session.list` row `id` **is** the session key that `session.resume`
  (RPC param `session_id`) and `host.openSession` accept
  (`tui_gateway/methods_session.py`).
- `session.resume` returns the live runtime `session_id` used for turn
  tracking and `busyBySession` matching.

### Migration

- Existing saved queues are valid as-is: cards saved before this change have
  no `target` field and run as new sessions, exactly as before.

## 2026-09-26 — Global model-slot gate (follow-ups no longer slip past the queue)

Commit: `5e57eb6`.

### Fixed

- **A follow-up you sent in another session could not stop the queue.** The
  v1 per-card wait only watched the card's *own* session via the
  renderer-derived `busyBySession` map, which only tracks sessions the UI
  watches. A follow-up in a different session (or another surface, or a
  card's own sub-agents) was invisible, so the next card could fire while the
  single local model was still busy.
- **New global gate:** every pump cycle and every pre-launch queries
  `session.active_list` (the authoritative, process-wide signal — each live
  session reports `working` / `starting` / `waiting` / `idle`). While **any**
  session is working/starting/queued the queue holds. 4 s poll, two
  consecutive clear readings required (kills single-blip false-clears),
  fail-open on an RPC blip (re-checked next cycle).
- While holding: status-bar chip reads `queue · waiting for model` and the
  board header shows `⏳ waiting for model…`.

### Unchanged

- The per-card **review gate** (background self-improvement reviews run on a
  daemon thread, not a TUI session, so they never appear in
  `active_list` — they are still gated via `thread=bg-review` log markers,
  30 s spawn grace, 20 s poll, fail-open on log blips).

## 2026-09-25 — v1 (initial release)

Kanban-style prompt queue for the Hermes desktop app:

- Pane docked below the session list; cards = prompts (add, edit, drag
  reorder, remove, retry failed, clear done).
- **▶ Play** drains the queue strictly top-down, one card at a time:
  `session.create` → `prompt.submit` → wait for the turn
  (`message.complete` + 10 s busy-poll fallback, 1 h stall → failed) →
  strict review gate → mark done → release the one-shot session's slot
  (sidebar row stays).
- Every card gets a real sidebar-visible session; restart-safe via plugin
  storage (a card running across a restart is re-attached or re-queued,
  never dropped).
- `::enqueue{prompt="…"}` transcript directive and a status-bar chip.

See [README.md](./README.md) for the full current feature list, install
steps, and known limitations.

## Deferred (by design decision, 2026-09-26)

- **Dropdown search filter** (C2) and **pinned targets** (C3) — superseded
  for the current scope by the manual session-ID field shipped in C1;
  revisit if the latest-10 list proves too small.
- **`@session` mention syntax** in prompt text (C4) — deferred until the
  picker has been used in practice.
