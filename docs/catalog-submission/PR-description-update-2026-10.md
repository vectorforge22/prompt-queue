# PR description draft (UPDATE) — NousResearch/hermes-agent: plugin-catalog/prompt-queue.yaml

> Draft v2 (template-aligned), 2026-10-17. Paste everything below the line into the PR body.
> Entry file: `plugin-catalog/prompt-queue.yaml` (mirror kept in this repo at
> `docs/catalog-submission/prompt-queue.yaml`).
> **Owner submission**: the PR author (vectorforge22) owns the plugin repo.
> Pin: `04314c08a9de003fbf5d58ab648a052a49b09b66` — vectorforge22/prompt-queue `main`
> (v1.4.4 + refreshed screenshot). `hermes plugins validate` passes at that commit
> (security scan safe, no core override, desktop surface inside SDK).

---

**Plugin:** Prompt Queue — **update** v1.1.1 → v1.4.4 (owner-submitted).

## What does this PR do?

Re-pins the Prompt Queue catalog entry from v1.1.1 to v1.4.4 and refreshes its
description and screenshot. Four minor versions since publication, one theme:
**targeting + autonomy hardening**. All changes are renderer-side in the same
single ESM file — no build step, no self-updating code, nothing fetched or sent
beyond the local Hermes gateway:

- **Card target modes** (v1.4.1/2) — each card targets a **new session**
  (default), an **existing session**, a **desktop project** (`project:<id>` /
  `project:new:<path>`, idempotent create), or a profile's canonical **"Bot
  Chat"**; two-row target picker in the composer + per-card.
- **Reload visibility** (v1.4.2) — reloading mid-work shows "queue restored · N
  pending — press Play" instead of masquerading as an idle queue; in-flight
  cards re-attach or re-queue, never drop. Picker preserves the gateway's
  last-activity order (contract now covered by a test).
- **Gate hardening** (v1.4.3/4) — two real-incident fixes on top of the
  existing "session must be idle" gate: an orphaned review spawn marker (gateway
  died mid-review, no terminal line ever appears) releases the lane after 3 h
  instead of failing cards on a dead process; and a **compaction gate** — the
  idle-resume compaction path reads IDLE in `session.active_list`, so a fresh
  (<60 min) compression start marker with no terminal line in `agent.log` now
  holds the single inference slot (`⏳ waiting for compaction…`); orphaned
  markers release, so a dead run can't wedge the queue.
- **Markdown ingest** — point the 📥 menu at a folder of `.md` files; every
  `## heading` / `- [ ]` checkbox becomes a deduped card (Windows-only file
  access). Optional local-model suggestions via `llm.oneshot` (stateless; never
  auto-queued).
- **Committed regression suite** — `test-plugin.mjs` at the repo root
  (`node --experimental-vm-modules test-plugin.mjs`) drives the real gate and
  hydration code through a node:vm harness with a faked SDK: review-gate
  verdicts (orphan + boundary), compaction-gate verdicts (60-min ceiling +
  boundary), the picker order-preservation contract, v3-payload reload
  hydration.

**SDK surfaces used (Desktop SDK only):** `ctx.register` (pane contribution
docked below the session list, status-bar chip, `TRANSCRIPT_DIRECTIVE_AREA` for
`::enqueue`); `host.request` RPCs: `session.create`, `session.list`,
`session.resume`, `session.close`, `session.active_list`, `session.title`,
`prompt.submit`, `projects.list`, `projects.create`, `profiles.list`,
`llm.oneshot`, `shell.exec`; `host.onEvent('message.complete')`,
`host.state.busyBySession`, `host.logs` (read-only tail of the local
`agent.log`), `host.openSession`.

**Surface notes (new since v1.1.1 — disclosed for review):**

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
  queue's gates or a live session; suggestions are always shown for review
  before they can become cards.
- **`host.logs`** — read-only tail (≤1000 lines) of the user's own
  `agent.log`, filtered to `thread=bg-review` and `context compression`
  markers; only timestamps/markers are parsed, nothing is stored or displayed.

Trust contract unchanged: renderer-only single ESM file importing only
`@hermes/plugin-sdk` + `react`; no network calls beyond the local gateway RPCs
above; no credential access; no self-update. `::enqueue` directive attributes
are treated as untrusted model output — ask-first chip by default, auto-add is
an explicit gear opt-in.

## Related Issue

N/A — owner-initiated catalog pin update for an entry previously merged via
[#131983](https://github.com/NousResearch/hermes-agent/pull/131983) (original
add, v1.1.0). No tracking issue exists.

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [x] ✨ New feature (non-breaking change that adds functionality)
- [ ] 🔒 Security fix (undisclosed vulnerabilities in [SECURITY.md](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md) §3.1 scope go to [Security Advisories](https://github.com/NousResearch/hermes-agent/security/advisories/new) first, not a public PR)
- [ ] 📝 Documentation update
- [ ] ✅ Tests (adding or improving test coverage)
- [ ] ♻️ Refactor (no behavior change)
- [ ] 🎯 New skill (bundled or hub)

## Changes Made

- `plugin-catalog/prompt-queue.yaml` — **the only file this PR changes**:
  - `version`: `"1.1.1"` → `"1.4.4"`
  - `sha` pin: `4851cd1…` → `04314c08a9de003fbf5d58ab648a052a49b09b66`
    (vectorforge22/prompt-queue `main`, v1.4.4 + refreshed screenshot)
  - `description`: rewritten to cover the four target modes and all three
    "wait until done" gates (session idle, review complete, compaction
    committed)
  - `screenshots[0]`: re-pinned to the new commit — shows the two-row target
    picker, all four modes, tab counts

What the pinned version contains beyond v1.1.1, by file in the plugin repo:
`desktop/plugin.js` (all of the above behavior), `test-plugin.mjs` (new
regression suite), `README.md` ("Who is this plugin for?" + gate docs),
`CHANGELOG.md`, `plugin.yaml`.

## How to Test

1. Clone at the pin: `git clone https://github.com/vectorforge22/prompt-queue && cd prompt-queue && git checkout 04314c08a9de003fbf5d58ab648a052a49b09b66`
2. `node --experimental-vm-modules test-plugin.mjs` → all suites pass (review-gate verdicts, compaction-gate verdicts incl. the 60-min boundary, picker order contract, reload hydration). Node 18+; no dependencies.
3. `hermes plugins validate <path-to-clone>` → `Validation passed` (security scan safe, no core override, desktop surface inside the plugin SDK).
4. Optional live check (Hermes desktop): queue two prompts with one inference slot available; start a compaction and press Play — the chip shows `⏳ waiting for compaction…` and the card fires only after the compaction's terminal line lands.

## Checklist

### Code

- [x] I've read the [Contributing Guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md)
- [x] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(scope):`, `feat(scope):`, etc.) — single commit: `chore(plugin-catalog): update prompt-queue to v1.4.4 (04314c0)`
- [x] I searched for [existing PRs](https://github.com/NousResearch/hermes-agent/pulls) to make sure this isn't a duplicate — original add #131983 is merged; no open update PR for prompt-queue
- [x] My PR contains **only** changes related to this fix/feature (no unrelated commits) — one catalog YAML file
- [ ] I've run `pytest tests/ -q` and all tests pass — N/A: single-file catalog YAML, no Python touched; CI's gate remains authoritative
- [ ] `python scripts/check` passes (the blocking lint and code-health checks CI runs) — N/A: same reason; catalog metadata is outside the lint surface
- [x] I've added tests for my changes (required for bug fixes, strongly encouraged for features) — the pinned version ships a committed node:vm regression suite (`test-plugin.mjs`) covering every gate verdict it adds; a catalog entry itself has no pytest surface
- [x] I've tested on my platform: Windows 11 (Hermes desktop; local Qwen3.8-27B via llama.cpp, one inference slot — the plugin's target environment)

### Documentation & Housekeeping

- [x] I've updated relevant documentation (README, `docs/`, docstrings) — or N/A — the catalog entry's description is refreshed by this PR; the plugin's README was updated at the pinned commit
- [ ] I've updated `cli-config.yaml.example` if I added/changed config keys — or N/A — N/A (no config keys; all state lives in plugin storage)
- [ ] I've updated `CONTRIBUTING.md` or `AGENTS.md` if I changed architecture or workflows — or N/A — N/A (no hermes-agent architecture or workflow change)
- [x] I've considered cross-platform impact (Windows, macOS) per the [compatibility guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md#cross-platform-compatibility) — or N/A — renderer-only JS with no platform APIs; all file access goes through gateway RPCs; developed and live-tested on Windows 11
- [ ] I've updated tool descriptions/schemas if I changed tool behavior — or N/A — N/A (no hermes-agent tool behavior change)

## Screenshots / Logs

- **Attached:** the queue pane at v1.4.4 — four queued cards covering all target
  modes (new session, project, Bot Chat, session follow-up), two-row picker,
  "4 queued · 2 done" header with tab counts, `Backend ready` status. Demo
  cards were seeded for the capture and removed afterwards; nothing was sent.
- **Log:** `hermes plugins validate` at `04314c0` → `Validation passed` —
  security scan safe · no core override · desktop surface stays inside the
  plugin SDK.
