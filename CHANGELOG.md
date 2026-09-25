# Changelog

Behavioral history for the `prompt-queue` desktop plugin, oldest feature-set
first. Dates are release dates on this repo's history.

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
