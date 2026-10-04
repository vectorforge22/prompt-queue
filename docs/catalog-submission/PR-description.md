# PR description draft — NousResearch/hermes-agent: plugin-catalog/prompt-queue.yaml

> Draft, 2026-10-02. Paste into the catalog PR body. **Not submitted.**
> Entry file: `plugin-catalog/prompt-queue.yaml` (this repo, `docs/catalog-submission/`).
> Pin: `da41ee7da408afd68e9e26aabb6f157b9fa24481` (main, v1.1.0).

---

**Plugin:** Prompt Queue — a kanban-style prompt queue for the Hermes desktop
app. **Owner submission** (I own the repo).

## What it does

Queues prompts as cards. **▶ Play** drains the queue strictly top-down, one
card at a time: each card becomes a real desktop session (visible in the
sidebar), runs its prompt, waits for the turn and for any background
self-improvement review to fully complete, then fires the next card. Cards
can target a new session (default) or an existing one (latest-10 picker or
pasted session ID). Includes Queue/Done/Skipped/Failed tabs, a resizable
composer, a per-card action menu, and a status-bar chip. Built for
local-model setups where one inference slot is shared with background
reviews.

## Surfaces used (Desktop SDK only — rule 8)

- `ctx.register` pane contribution (docked below the session list),
  status-bar chip, and `TRANSCRIPT_DIRECTIVE_AREA` (`::enqueue`).
- `host.request` gateway RPCs: `session.create`, `session.list`,
  `session.resume`, `prompt.submit`, `session.close`, `session.active_list`.
- `host.onEvent('message.complete')`, `host.state.busyBySession`,
  `host.logs` (review-gate detection), `host.openSession`, `ctx.storage`
  (queue + settings persistence).
- Single static `desktop/plugin.js` (ESM, ~1.3k lines); no build step, no
  Python half, no dependencies, no self-updating code.

## Rule 13 disclosures (what a user would want to know before installing)

- **A queued card is a full agent turn** in a real session with that
  session's complete tool access. The queue is an autonomy surface: Play is
  explicit, and nothing runs without it.
- **No network calls** beyond the local Hermes gateway RPCs listed above;
  **no credential access**; no telemetry; no stored credentials.
- **Reads `agent.log`** (last 1000 lines, filtered for `bg-review`
  markers) to detect background reviews; parses timestamps/markers only,
  stores nothing. That log can contain other sessions' content — disclosed
  here and in the README's *Trust & Autonomy* section.
- **`::enqueue` transcript directive** — per the platform contract,
  directive attributes are *untrusted model output*, so the default is
  **ask-first**: the directive renders a button the user clicks to accept;
  auto-add is an explicit opt-in in the plugin's settings. (This design was
  hardened after a community review flagged the untrusted-input path.)
- **Review gate** holds the queue while a background review runs; on a log
  verification error it **fails closed** by default (visible holding state,
  auto-retry); fail-open is an opt-in.
- Long-running: a card's turn can run for hours on local models; the
  plugin never force-closes a session whose turn may still be running.

## Validation

`hermes plugins validate` passes at the pinned commit: manifest OK,
`requires_hermes >=0.21.5`, loadable `desktop/plugin.js`, **security scan
safe**, **desktop surface stays inside the SDK**. (One expected warning:
no `__init__.py` — this is a manifest-only desktop plugin; the capability
probe is skipped by design.)

## Screenshot

One screenshot (the pane with cards + tabs), pinned to the SHA:
`docs/screenshots/prompt-queue.png`.

---

## Internal pre-submit checklist (delete before submitting)

- [ ] `hermes plugins validate` re-run against a fresh clone at the pinned
      SHA (not just the working tree) — cheap insurance
- [ ] README at the pinned SHA renders acceptably (it's the catalog page)
- [ ] Arthur approves the PR description wording
- [ ] Fork NousResearch/hermes-agent → add `plugin-catalog/prompt-queue.yaml`
      → open PR with the description above
- [ ] Watch the catalog CI job (clones the pin, re-runs validate) — fix
      anything red
- [ ] After merge: note the listing URL in the README; the AtlasOmnia
      directory listing (PR #7, closed as incorporated) stands as-is
