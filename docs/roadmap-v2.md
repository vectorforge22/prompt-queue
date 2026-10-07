# Prompt Queue — Roadmap v2 (feature assessment + phase plan)

Status: **assessment** (2026-10-07). Branch `roadmap`, base `main` @ v1.1.1.
Catalog PR #131983 **merged** (2026-10-07) — v1.1.1 is the published pin.
Every gateway primitive below was verified in `tui_gateway/` source (checkout
`C:\Users\Arthur\AppData\Local\hermes\hermes-agent`), not taken on faith from
docs.

## Phase status

- **Phase 1 (Project targeting) — IMPLEMENTED 2026-10-07** (v1.2.0 on
  `roadmap`): `project:<id>` + `project:new:<path>` targets in the picker,
  `projects.list`/`projects.create` RPCs, `session.create {cwd}`, idempotent
  create with card re-anchoring, storage payload v2 (same key — live queues
  survive). Pending: Arthur's real-run eyeball (pick a project target,
  Play, confirm the session lands under the project in the sidebar).

## Feature feasibility (verified against source)

### 1+2. New session in existing / new Project — ✅ feasible, pure renderer
- `projects.list`, `projects.get`, `projects.create`, `projects.set_active`,
  `projects.for_cwd` exist (`tui_gateway/methods_projects.py`, `@_projects_method`);
  contracts in `tui_gateway/contracts/projects_pets.py`. Plugins reach them via
  `host.request` (the SDK's generic gateway door — `apps/desktop/src/sdk/index.ts`).
- Projects are real entities: 11 rows in this box's `projects.db`.
- `session.create` accepts `cwd` (`contracts/sessions.py::SessionCreateParams`);
  a session's project membership derives from cwd
  (`hermes_cli.projects_db.project_for_path`), so creating a session with
  `cwd = project.primary_path` lands it in that project's sidebar subtree.
- New project = `projects.create {name, path}` then `session.create` with that
  cwd. Note: `desktop_project` (the agent tool) is GUI-only and re-anchors the
  *calling* session — the plugin must use the RPCs directly, not the tool.
- No file dialog in the plugin SDK → "new project" path is a text field
  (optionally pre-filled from the sidebar's discovered repos).

### 3. Web UI dashboard — ⚠️ study item, three known shapes
- (a) **hermes-workbench** (catalog, community): serves the actual desktop UI
  through the dashboard for headless/VPS/tablet. Off-the-shelf, not ours.
- (b) **Custom dashboard routes** (`plugin_api.py`, the
  hermes-cloud-file-manager / boardstate / kanban-gantt pattern): a queue
  status page under gateway auth. Needs an agent-side component.
- (c) **Sidecar** (Laya pattern): rejected by default on this box (manual
  restart after every reboot, supervision deferred).
- Deliverable = a decision doc, not code.

### 4. 'Bots' mode and other modes — ✅ feasible as a targeting layer
- Bot Mode is a **core** desktop feature: one bot = one profile with a
  canonical hidden session titled `Bot Chat`
  (`apps/desktop/src/plugins/hermes-bots/`, canonical-chat registry docs in
  `apps/desktop/src/AGENTS.md`). Resolution pattern is public:
  `session.list {title: "Bot Chat", include_hidden: true}` scoped to the
  profile.
- Clean design: a **mode = a named target resolver** (card → session-create or
  resume params). Existing card targeting (new session / existing session)
  becomes two built-in modes; add `bot`, `project` (phase 1), later `kanban`.
  Gear holds the default mode; per-card override lives on the card.

### 5. Queue from Telegram / messaging — ⚠️ largest item, needs agent-side piece
- A renderer-only plugin has no inbound push channel from the messaging
  gateway. Realistic shapes:
  - **Agent-side watcher** (optional subpackage: hook or cronjob) on a
    designated Telegram channel → writes into an inbox the desktop plugin
    polls → ask-first chips.
  - Webhook route (`webhook_subscriptions` exists in hermes home) — study in
    phase 4.
- Trust: messaging content is untrusted → **always ask-first, never
  auto-add**; sender allowlist.
- Depends on which platforms Arthur actually runs (check gateway config when
  the phase starts).

### 6. Ingest markdown → suggest tasks — ✅ feasible, two read paths
- File read from renderer: no fs API in SDK. Path A: `shell.exec`
  (`tui_gateway/methods_tools.py`) — 30 s timeout, approval-gated, stdout
  **tailing last 4000 chars** → chunk large files with explicit line ranges.
  Path B (better, once the agent-side subpackage exists): a dashboard route
  that serves file bytes (cloud-file-manager precedent).
- Suggestion: `llm.oneshot` RPC (`methods_session.py`) — stateless, and with
  `session_id` it borrows that session's model → runs on local S1, **no cloud
  cost**. Fallback: heading/checkbox regex extraction, no model needed.
- Suggestion rendering reuses the existing **ask-first chip** pattern
  (untrusted-content trust model already built and catalog-reviewed).

### 7. README use-cases — ✅ pure docs, small.

### Future: Obsidian VectorForge22 Kanban integration — ⚠️ agent-side
- Prior art: **kanban-gantt** (catalog) = dashboard routes over kanban.db +
  `/events` websocket + desktop page. Same shape fits here: agent-side routes
  read/write the board, desktop pane renders it and bridges cards
  (queue card → kanban task and vice-versa). Own milestone, own branch.

## Editions question — recommendation: **no split; gate, don't fork**

The concern is real (every new surface multiplies upstream-update breakage
and catalog-review exposure), but three separate plugins/editions would mean
3× maintenance, 3× catalog entries, and a storage-format split (queue state
lives in one plugin's `ctx.storage` — Lite's cards can't feed Pro's engine).

Instead:
1. **One plugin id, one repo, one catalog entry.**
2. **Feature gates in the gear** (pattern already exists: auto-add,
   fail-open): Projects targeting, Bot mode, Markdown ingest, … each off by
   default until Arthur enables it. A broken gate degrades one feature, not
   the queue.
3. **Versioned storage schema** (bump on each feature landing) so an update
   can't corrupt existing queues.
4. **Growth path when a feature needs the gateway side** (messaging, kanban,
   robust file ingest): the repo gains an **optional agent-side subpackage**
   (`plugin.yaml` + `__init__.py` + `dashboard/plugin_api.py`) — the
   hermes-agent-builder / spotify-desktop "unified agent+desktop" shape —
   still under the same plugin id, installable but disabled by default.
   That subpackage *is* the practical "Pro-Connected" tier without a second
   distribution.
5. Revisit true distribution split only if a catalog reviewer rejects the
   surface size, or a feature needs different trust/review boundaries.

## Phase plan

| # | Phase | Items | Risk | Exit criteria |
|---|-------|-------|------|---------------|
| 1 | Project targeting | #1, #2 | low | Card runs into a session that appears under the chosen project in the sidebar; new-project card creates the project first; storage schema v2 migration tested |
| 2 | Modes | #4 | low-med | Mode = target resolver refactor; `bot` mode opens/creates the canonical Bot Chat for the picked profile; default-mode gear + per-card override |
| 3 | Markdown ingest | #6 | med | Path field + chunked `shell.exec` read; `llm.oneshot` (borrowed session model) or regex fallback; suggestions as ask-first chips with project/target prefill |
| 4 | Web UI study | #3 | low (docs) | Decision doc in `docs/`: workbench vs dashboard routes vs sidecar, with a recommendation for this box |
| 5 | Messaging inbox | #5 | high | Agent-side watcher (opt-in subpackage) + polled inbox + ask-first chips + sender allowlist; requires platform setup decision |
| 6 | README use-cases | #7 | low | Use-cases section written as features land (first pass after phase 1; final after 5) |
| F | Kanban bridge | future | high | Separate milestone/branch; kanban-gantt shape (dashboard routes + websocket) |

Ordering rationale: 1 and 2 are pure-renderer, build on the existing engine,
and de-risk the storage refactor everything else rides on. 3 needs 1's project
model. 4 is a study and can run alongside. 5 is deliberately last: it's the
only item that changes the plugin's trust boundary (untrusted inbound) and
the only one that forces the agent-side subpackage — by then the repo shape
is stable.

## External usage study (catalog, 2026-10-07, 115 desktop plugins)

Differentiation check: **no catalog plugin does gated autonomous queue
execution** — prompt-queue's niche (one-at-a-time, review-gated, restart-safe
autonomous runs) is unoccupied. Nearest neighbors and what they contribute:

- **prompt-tray** — saved prompts inserted into the composer. No execution,
  no gating. Confirms demand for prompt management; nothing to copy.
- **prompt-studio** — AI prompt builder; AI calls via an auxiliary task.
  Precedent for the `llm.oneshot`/aux pattern in phase 3.
- **kanban-gantt** — dashboard routes over kanban.db + `/events` websocket +
  desktop page, task creation with project/skills/model override. The
  reference architecture for the future kanban bridge.
- **hermes-agent-builder** — BOTS guided workspace; "save agent" creates
  profiles; native Bot Chat handoff. Confirms bot = profile + canonical chat.
- **pinned-folders** — SDK-only sidebar organization (nested pin folders).
  Candidate inspiration: a per-project queue view later.
- **boardstate / hermes-cloud-file-manager / hermes-workbench** — the three
  agent-side component shapes to choose from in the phase-4 study.

Additional feature candidates surfaced by the study + this box's reality
(rank-ordered, not scheduled):
1. **Queue history/stats tab** — per-card duration, failures, retry counts;
   data already exists in storage. Cheap, high value for tuning local-model
   runs.
2. **Multiple queues / per-project queue view** — natural after phase 1.
3. **Export/import queue (JSON)** — restart handoff, cross-box migration.
4. **Scheduled enqueue** — cronjob that drops a card at a time (the plugin
   creates the job; the directive's ask-first chip still gates execution).
5. **Re-run last N / duplicate card** — small UX.
6. **Voice capture into composer** — `wake.*` RPCs exist in core; low
   priority.
