# Prompt Queue — Hermes Desktop plugin

Kanban-style prompt queue for the [Hermes desktop app](https://hermes-agent.nousresearch.com/docs).
Each card is a prompt. Press **▶ Play** and the queue drains strictly top-down:
each card becomes a **real new desktop session** (visible in the sidebar, openable
with the ↗ on the card), runs its prompt, waits for the turn to finish, waits for
any **background self-improvement review** to fully complete (strict gate), then
fires the next card.

Built for feeding a local-model setup a list of prompts one fresh session at a
time — without the next prompt fighting the background review for the inference
slot — while keeping every session visible in the normal sidebar.

## What it adds

- **Pane** — docked below the session list (bottom-left of the default layout);
  drag it anywhere.
- **Cards** — add (textarea, Ctrl/⌘+Enter or **+ Add**), edit (✎), reorder
  (drag ⋮⋮), remove (×), retry failed (↻), open the card's session (↗), clear
  done (✕ done).
- **Strict review gate** — no new prompt is fired while a background
  memory/skill review is still running (detection: `review.summary` event +
  `thread=bg-review` log markers, 30 s spawn grace, 20 s poll, fail-open on
  log blips).
- **Slot hygiene** — after a card's turn, its one-shot session's
  active-session slot is released (`session.close`; the sidebar row stays), so a
  long queue can't exhaust the session cap.
- **Restart-safe** — queue state persists via plugin storage; a card running
  across an app restart is re-attached (or re-queued, never dropped).
- **`::enqueue{prompt="…"}` transcript directive** — a chat turn can add a card
  to the queue (deduped by `id`/prompt prefix). Tell your agent the directive
  exists; it won't discover the name on its own.
- **Status bar chip** — right cluster: `queue · N active, M next` /
  `queue paused · M waiting` / `queue idle`.

## State machine

```
queued → launching → running → review-wait → done
              └────────┴─────────┴──┴─────────→ failed (with retry)
```

Per-card watchdogs: 10 s `busyBySession` poll (missed-event fallback),
1 h hard stall → `failed` (session left open, not force-closed).

## Install

Renderer-only disk plugin (single ESM `plugin.js`, no build step):

1. Create a folder named `prompt-queue` under your desktop plugins dir —
   `~/.hermes/desktop-plugins/prompt-queue/` (or
   `$HERMES_HOME/desktop-plugins/prompt-queue/` when a profile is active).
2. Copy this repo's `plugin.js` into it.
3. The app hot-reloads within seconds. If it doesn't appear: ⌘K →
   **Reload desktop plugins**. A load failure shows a toast naming the error.
4. Manage (enable/disable) in **Settings → Plugins**.

## Requirements

A desktop build recent enough for: `host.request` gateway RPCs
(`session.create`, `prompt.submit`, `session.close`),
`host.onEvent('message.complete')`, `host.state.busyBySession`, `host.logs`,
`ctx.storage`, pane contributions with `dock`, and `TRANSCRIPT_DIRECTIVE_AREA`.
Developed and verified against the 2026-09 build (all of the above confirmed
in `tui_gateway/` + `apps/desktop/src/sdk` source).

## Known limitations

- The engine never submits into a mid-turn session (one card at a time), but a
  card whose turn stalls >1 h fails with the session left running rather than
  force-closing it.
- Reorder only applies to non-live cards (a live card is mid-flight).
- The review gate is global (one review can run app-wide), matching the
  harness: a review spawned by *any* session gates the next card.
- One-prompt sessions never trigger their *own* background review (the nudge
  counters are per-session) — the gate covers reviews from any session, which
  is the inference-slot protection that matters.

## License

[MIT](./LICENSE)

## Listing (AtlasOmnia community-plugins)

```
| [Prompt Queue](https://github.com/vectorforge22/prompt-queue) | Kanban-style prompt queue: Play drains cards one at a time, each into a new sidebar session, gated on background-review completion | [@vectorforge22](https://github.com/vectorforge22) |
```

Suggested category: **Tasks & Notes** (or Collaboration & Workflow).
