# PR description draft (UPDATE) — NousResearch/hermes-agent: plugin-catalog/prompt-queue.yaml

> Draft, 2026-10-15. Paste into the catalog update PR body.
> Entry file: `plugin-catalog/prompt-queue.yaml` (kept in this repo at
> `docs/catalog-submission/prompt-queue.yaml`).
> **Owner submission (rule 5)**: the PR author (vectorforge22) owns the repo.
> Pin: `<FINAL ROADMAP COMMIT — fill at submit time>` (roadmap branch, v1.4.4).
> Must be a commit on which `hermes plugins validate` passes locally
> (manifest, loadable desktop/plugin.js, security scan SAFE, SDK-clean).

---

**Plugin:** Prompt Queue — **update** v1.1.1 → v1.4.4 (owner-submitted).

## What changed since the published pin (v1.1.1)

Four minor versions, one theme: **targeting + autonomy hardening**. All
changes are renderer-side in the same single-ESM file — no build step, no
self-updating code, nothing fetched or sent beyond the local Hermes gateway.

- **Card target modes** — each card now targets a **new session** (default),
  an **existing session**, a **desktop project** (`project:<id>` /
  `project:new:<path>`, idempotent create), or a profile's canonical
  **"Bot Chat"** (bot mode, name-as-identity, resolved at fire time). A
  two-row target picker lives in the composer.
- **Markdown ingest** — point the 📥 menu at a folder of `.md` files; every
  `## heading` / `- [ ]` checkbox becomes a deduped card (Windows-only file
  access, details below). Optional local-model suggestions via `llm.oneshot`
  (stateless; suggestions are never auto-queued).
- **Gate hardening — three real-incident fixes**:
  - *Review gate*: an orphaned spawn marker (the gateway died mid-review, so
    no terminal line ever appears) releases the lane after 3 h instead of
    failing cards on a dead process.
  - ***Compaction gate (new)***: the idle-resume compaction path holds the
    single inference slot while its session reads IDLE in
    `session.active_list`; a fresh (<60 min) compression start marker with no
    terminal line in `agent.log` now holds the lane
    (`⏳ waiting for compaction…`). Orphaned markers release — a dead run can't
    wedge the queue.
  - *Reload visibility*: reloading mid-work shows "queue restored · N pending
    — press Play" instead of masquerading as an idle queue; in-flight cards
    re-attach or re-queue, never drop.
- **Committed regression suite** — `test-plugin.mjs` at the repo root
  (`node --experimental-vm-modules test-plugin.mjs`) drives the real
  gate/hydration code through a node:vm harness with a faked SDK: review-gate
  verdicts (orphan + boundary), compaction-gate verdicts (60-min ceiling +
  boundary), the picker order-preservation contract, and v3-payload reload
  hydration.

## Surfaces used (Desktop SDK only — rule 8)

- `ctx.register`: pane contribution (docked below the session list),
  status-bar chip, `TRANSCRIPT_DIRECTIVE_AREA` (`::enqueue`).
- `host.request` gateway RPCs: `session.create`, `session.list`,
  `session.resume`, `session.close`, `session.active_list`, `session.title`,
  `prompt.submit`, `projects.list`, `projects.create`, `profiles.list`,
  `llm.oneshot`, `shell.exec`.
- `host.onEvent('message.complete')`, `host.state.busyBySession`,
  `host.logs` (read-only tail of the local `agent.log`), `host.openSession`.

**Surface notes (new since v1.1.1):**

- **`shell.exec`** — used ONLY by markdown ingest, and only on explicit user
  click: file reads in 45-line windows (`type`), folder/template creation
  (`mkdir`, `echo >`, `certutil -f -decode` for base64 scratch files), and
  `explorer` to open a folder. Paths are blocklist-validated (drive-letter or
  `%ENVVAR%` root; `& | < > ^ ; % "` and CR/LF rejected) and every argument is
  single-quoted once — the standard remediation for the CVE-2024-27980 /
  BatBadBut class. Interpreter script flags are hard-blocked by the approval
  gate and never used. No other feature touches `shell.exec`.
- **`llm.oneshot`** — optional card-text suggestions from ingested markdown
  blocks: stateless, resolves the local auxiliary model, never touches the
  queue's gates or a live session, and suggestions are always shown for
  review before they can become cards.
- **`host.logs`** — read-only tail (≤1000 lines) of the user's own
  `agent.log`, filtered to `thread=bg-review` and `context compression`
  markers; only timestamps/markers are parsed, nothing is stored or displayed.

## Trust & autonomy (contract unchanged)

- Renderer-only single ESM file; imports only `@hermes/plugin-sdk` + `react`.
- No network calls beyond the local gateway RPCs above; no credential access;
  no self-update.
- `::enqueue` directive attributes are treated as **untrusted model output**:
  ask-first chip by default; auto-add is an explicit gear opt-in.

## Verification

- `hermes plugins validate` at the pinned commit.
- Committed regression suite (above), plus live use on the maintainer's box:
  v1.4.3/v1.4.4 were developed against two real incidents — a PC reboot
  mid-review orphaning the spawn marker, and a stale compaction badge racing a
  queued prompt — both fixed and covered by tests.
- Bot mode real-run verified: a card targeting a profile lands in that
  profile's canonical Bot Chat session.

## Screenshots

`docs/screenshots/prompt-queue.png`, re-pinned to the new SHA. A refresh
showing the two-row picker + tabs is pending — offered with the next update if
reviewers would like one.
