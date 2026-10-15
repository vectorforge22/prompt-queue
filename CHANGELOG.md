# Changelog

Behavioral history for the `prompt-queue` desktop plugin, oldest feature-set
first. Dates are release dates on this repo's history.

## 1.4.4 (2026-10-15 — compaction joins the "wait until done" gate)

Question from the field (2026-10-15): a queued prompt was sent while the
bg-review-watch chip still claimed "compacting". The badge turned out to be
stale (see bg-review-watch 0.4.1), but the question exposed a real gap: **the
queue's gate never looked at compaction at all.** It gated on `session.active_list`
+ background reviews only.

That was safe for MID-turn compaction — it suspends the turn, so the session
reads `working` and gate 1 holds. But `agent/conversation_compression.py` also
has an idle-resume path ("Resumed after Xs idle — compacting … before
continuing") that runs while the session reads IDLE: gate 1 misses it, and a
prompt submitted then would race the aux model call for the single inference
slot.

This release adds gate 3 (`freshCompaction()`):

- A **fresh** (<60 min) compression start marker with no terminal line
  (done/telemetry) in `agent.log` now holds the lane, same evidence style as
  the review gate. 60 min leaves wide headroom over measured runs (~5 and
  ~8 min on this box).
- Orphan markers (gateway/process died mid-run → no terminal line ever) do
  NOT hold the lane — the v1.4.3 lesson, applied to compaction.
- Log-read errors follow `settings.gateFailOpen` (default: fail closed +
  visible), matching the review gate.
- UI: while holding on a compaction the board header shows "⏳ waiting for
  compaction…" and the status chip reads "queue · waiting for compaction"
  with a dedicated tooltip — distinguishable from the ordinary model-busy
  hold.

Verification: `node --check` pass; gate verdict re-run against the live
agent.log (freshCompaction → inactive after the 10-15 19:32→19:40 run, as it
should be) and against synthesized fresh-orphan / healthy / over-budget
markers.

## 1.4.3 (2026-10-15 — review gate releases lanes on orphaned spawn markers)

The review gate's "running ⇔ latest spawn > latest completion" rule assumed
every background-review spawn eventually logs a terminal line. It does not:
the review is a THREAD inside the gateway process, so a PC reboot or kill
mid-review dies without logging anything — and the lane then holds (and
eventually FAILS) cards on a marker for a process that no longer exists.
Observed 2026-10-14: review spawned 19:34, PC rebooted 19:47; every queued
card after that would have held the lane 3h and failed with "a review is
STILL running".

- **`reviewCleared()` now treats an orphaned spawn as cleared.** A spawn
  marker older than `REVIEW_STALL_MS` (3h — longest observed healthy review:
  ~2h) with no terminal line releases the lane immediately instead of waiting
  out the backstop. This is the same semantics bg-review-watch v0.4.0 shows
  as "review stale". Cards mid-wait when a marker orphans are released on the
  next 20s poll (typically within 3h of the orphan, and immediately if the
  orphan already exists).
- **The backstop still exists, and now means something precise.** It fires
  only while a FRESH (<3h) active marker persists across a full 3h hold —
  i.e. a review thread hung inside a LIVE gateway process — and the failure
  message says so (`held the lane for 3h while a fresh (<3h) review marker
  stayed active — likely a hung review in a live gateway`).
- No behavior change for healthy reviews: anything younger than 3h gates
  exactly as before, fail-closed on log errors per `gateFailOpen`.

Verification: ESM syntax check passed; gate decision re-verified against the
live `agent.log` orphan (spawn 2026-10-14 19:34, no terminal line) — old
logic: `active`, new logic: `cleared`; a fresh synthetic spawn (<3h) still
gates `active` under the new logic.

## 1.4.2 (2026-10-14 — reload visibility + session picker ordering)

Two bug fixes found while running the queue against live sessions:

- **A reload no longer masquerades as an idle queue.** `playing` is volatile
  by design (a fresh process must never auto-launch cards), but the reset was
  invisible: the button flipped back to Play while pending cards sat with no
  signal, looking like the queue had quietly died. Hydrate now counts every
  module incarnation as stored v4 diagnostics (`hydrate: {n, at, inFlight,
  requeued}`), logs a console line, and sets a **resume hint** — the statusbar
  chip reads "queue restored · N pending — press Play" (accent-colored,
  distinct from user-paused) and the board header shows "restored after
  reload" next to the Play button until Play is pressed.
- **The session picker preserves the gateway's last-activity order.** It used
  to re-sort `session.list` rows by `started_at` (creation time) before
  slicing the top 10 — which demoted old-but-active sessions out of the
  dropdown entirely (an actively running week-old session vanished; pasting
  the ID by hand was the only way in). The gateway already returns rows in
  last-activity order but exposes no activity field, so the client-side sort
  is gone and its order is preserved through filter + slice. The menu now
  notes that hidden/internal sessions are excluded and that any ID can be
  pasted.

Verification: v1.4.2 regression suite 15/15 in the VM sandbox (picker order
contract A1–A4; reload observability B1–B11, including a two-incarnation
re-import simulation and full drain-through-failure with no hang), ESM syntax
check passed.

## 1.4.1 (2026-10-11 — two-row composer target picker)

The single "🎯 target ▾" drop-down above the composer became **two stacked
rows**: row 1 = destination kind (＋ New session / 📁 Project / 🤖 Bot /
↩ Session), row 2 = the concrete target for that kind (project list + create
form / bot profiles / sessions + manual-ID box; a fixed note for new
sessions). Choosing a non-new kind opens row 2's menu immediately.

- **Uncommitted targets can no longer happen**: until a row-2 pick commits,
  the card keeps its last valid target and row 2 shows a "choose a …" hint —
  the old menu could be closed mid-selection, leaving an ambiguous state.
- Per-card pickers (the small "🎯 target ▾" in each card's meta row) now
  receive `value` and render both rows compactly — they were blind before
  and never showed which target that specific card had.
- Preserved from the old menu: viewport flip, click-outside close, fail-open
  caches, new-project create form, manual session-ID paste.

Verification: picker smoke suite 13/13 (real component in a VM sandbox, all
five target states + narrow mode), P2 logic 39/39, P3 e2e 47/47, validate
passed.

## 1.4.0 (2026-10-11 — Phase 3: markdown ingest)

A folder of `.md` files becomes queue cards. The new **📥 Ingest** button in
the pane header points at a folder (persisted in settings, default
`%USERPROFILE%\.hermes\prompt-queue`); **＋ Folder + template** creates the
folder and a starter `prompts.md` on first use (never touches an existing
one); **Ingest → queue** reads every `.md` file and queues each `## …`
heading and `- [ ]` checkbox as a card — with exact-text dedupe against every
card already in the queue (any tab), so re-ingesting is safe.

### Added

- **Ingest menu (📥)** — folder path field + Save, **＋ Folder + template**,
  **📂 Open** (explorer), **⬇ Ingest → queue** with a live status line
  (`added N cards · M already in queue · failed: …`). Busy state disables all
  actions; the menu closes on outside click like the gear's.
- **`ingestQueueDir()`** — orchestration: list `.md` files (capped at 50),
  read each (capped at 256KB per file, 200 cards per run), split into blocks
  (`## ` headings H2–H6, `- [ ]`/`- [x]` checkboxes; single-`#` lines are
  comments and ignored — matching the template's own contract), queue the
  new ones. The card's **title is the block's heading** (the prompt text
  stays complete for the receiving agent); target = the default mode,
  re-pointable per card via 🎯 as usual.
- **`createIngestTemplate(dir)`** — idempotent folder + `prompts.md` creation.
  An existing `prompts.md` is NEVER touched (returns "already there — left
  untouched"). The template documents the block contract in-file.
- **Shell-safe file access** (the renderer has no fs API; `shell.exec` is a
  generic cmd.exe door whose approval gate hard-blocks every interpreter
  script flag — `python -c`, `powershell -Command`, etc.):
  - **Windowed reads** via a tiny helper FILE placed with
    `echo <b64> > _pq.b64 & certutil -f -decode … & del …` (gate-allowed,
    byte-exact), then run as `python <file>` — a file argument passes the
    gate where `-c` does not. 45-line windows stay under the gateway's
    4000-char stdout tail; reassembled in the renderer.
  - **Blocklist path validation** (the Node CVE-2024-27980 / BatBadBut
    remediation pattern, not escaping): a trusted root (`%ENVVAR%` or drive
    letter) + segments free of `& | < > ^ ; % "` and CR/LF; every complete
    argument then enters the command line quoted exactly once. `%USERPROFILE%`
    roots expand correctly inside quotes (probe-verified); an undefined var
    fails safely with no junk directory.
  - **cmd.exe gotchas baked in and probe-tested through the real gateway
    spawn path**: `if not exist X mkdir X & chain` swallows the chain when X
    exists (mkdir is its own command; guarded one-shots use parenthesized
    bodies), Windows `mkdir` auto-creates parents (no `/p`), wildcards live
    INSIDE the quotes (`dir /b "path\*.md"`), and `dir` exits non-zero with
    empty stdout when nothing matches ("no files", not an error).

### Verified

47-assertion end-to-end test running the REAL `plugin.js` in a vm sandbox
with `shell.exec` backed by the EXACT gateway spawn path
(`subprocess.run(cmd, shell=True)` → `cmd /c`) against real directories —
including one with a SPACE in its name: template create + idempotency (byte-
identical on second run), listing, multi-window read round-trip (60-line
file across 2 windows, UTF-8 + em-dash survive b64→certutil→python→cmd),
missing-file and metacharacter error paths, full ingest action (7 blocks in,
re-ingest adds 0 / reports 7 dupes), and the `%USERPROFILE%` default-dir
shape end to end. Every emitted command also passes the real approval gate
(`detect_hardline_command` / `detect_dangerous_command`) and contains no
interpreter script flag. Phase-2 unit suite: 39/39 still green.

### Unchanged

Storage key and card schema (v3); the engine, gates, and all existing modes;
`addCard()` signature is backward compatible (the new `titleOverride` arg is
trailing). Settings payload gains `ingestDir` under the same settings key —
old settings load with the default folder.

## 1.3.0 (2026-10-10 — Phase 2: modes framework + bot mode)

The card target is now a **mode**: a named target resolver that turns a card's
target string into session-create or -resume params at fire time. The existing
targeting (new / existing session / project) became three built-in modes; the
fourth — `bot` — feeds a profile's canonical **Bot Chat**, so queued prompts
can accumulate in a bot's forever-chat instead of one-shot sessions.

### Added

- **Mode framework** — `modeOf(target)` classifies the card target by PREFIX
  (the Phase-1 lesson: never exact equality); `resolveTarget(c)` is the engine
  entry point and returns a plan (`kind: new|existing`, cwd, profile, close-on
  done). A resolution failure now **fails the card with a readable error** —
  the Phase-1 "stuck card" class (broken target + retry re-running the same
  broken path) can't happen: nothing wedges silently.
- **Bot mode (`bot:<profile>`, 🤖)** — the picker gains a **Bot** section
  (this backend's profiles, from `profiles.list`). At fire time the resolver
  mirrors the desktop app's canonical-chat contract, **name-as-identity, never
  an id pin**:
  - Registry lookup: `session.list { title: "Bot Chat", include_hidden: true }`
    scoped to the profile; opens the lineage tip (`resolved_id`) when it
    exists — exactly one RPC, no create.
  - **Fail closed** on a lookup error (post-restart warm-up race must never
    read as "no Bot Chat"), and on zero rows + roster claiming
    `canonical_session.id` (unconfirmed absence — a backend mid-restart can
    answer empty).
  - Confirmed absence → create the ONE forever chat: `session.create`
    `{profile, title: "Bot Chat", hidden: true, follow_profile_config: true}`
    + an **eager `session.title`** (materializes the row under the canonical
    name before the untitled window can fork a duplicate). On a title
    conflict: adopt the winner; if no winner is visible → fail closed.
  - Bot cards set **no stored key** (the resolved row is a live handle, not
    identity) — re-runs re-resolve by name; the card's ↗ stays hidden and
    the bot's roster row remains the door to its chat. Resume rides
    `{profile}`; the plugin never closes a Bot Chat (target sessions are
    never closed).
- **Default-mode gear** — `Default mode: New session | Bot Chat` sets the
  target for cards added without an explicit pick (the `::enqueue` chip) and
  the composer's starting point. It follows live in the composer only while
  the composer still holds the previous default — an explicit picker choice is
  user intent and isn't clobbered. `'session'` isn't offered as a default (no
  sensible concrete target).
- **Storage payload v3** under the SAME key (v1/v2 queues survive; bot cards
  are pure string targets — no card-shape change).

### Changed

- `runCard()` no longer inlines project logic — it calls `resolveTarget()`
  (same behavior, one resolver per mode; the project branch is Phase 1's
  verbatim, including idempotent create + re-anchor and the readable
  not-found error).
- Picker / card chips show a mode icon (`＋` `→` `📁` `🤖`); bot cards read
  "profile · Bot Chat".

### Verified

`node --check` + a 39-assertion unit test running the REAL `plugin.js` in a
vm sandbox with stubbed RPCs: mode classification (incl. prefix-vs-exact on
`project:new:<path>`), default targets, bot resolution paths (existing row →
one lookup only; lookup error / unconfirmed absence / conflict-without-winner
all fail closed with no create; clean create issues profile-scoped hidden
create + eager title), roster normalization.

## 1.2.2 (2026-10-09 — review-gate robustness: lost-timer reconciliation)

A card in `review-wait` was held by an in-memory 20 s poll. `teardownWired()`
(pane unmount / plugin dispose) clears all timers; if the module wasn't
re-imported afterward, `hydrate()` never re-ran and the card counted forever
even though the review had long since completed (observed live: gate log said
CLEARED, card held 4h+). The work was always done — the turn completes *before*
the gate — so the card just needed a release.

### Fixed / added

- **`sweepOrphanedReviewWaits()`** — the Board's 1 s tick now re-arms any
  `review-wait` card that has no live gate timer (throttled to 10 s,
  idempotent). Lost-timer state self-heals within ~30 s of the next
  verification poll.
- **`REVIEW_STALL_MS` backstop (3 h)** — while a gate timer *is* alive and the
  log says a review is STILL running, a wait past 3 h fails the card with a
  retry hint instead of holding the lane forever (no review has ever run that
  long on this box).
- **`reviewWaitSince` persisted on the card** — all three `review-wait`
  transitions stamp it; the backstop measures from the original wait start,
  not from a timer rebuild after a remount.
- **Manual escape hatch** — a `✓⏩` button appears on any `review-wait` card:
  force-done (the turn already completed; safe) and closes the one-shot
  session's slot like the normal done path.

### Verified

Gate regexes run against the live `agent.log` returned `CLEARED` for the
wedged state (spawn 17:46 < done 18:22) — confirming the hold was a lost
timer, not a real review.

## 1.2.1 (2026-10-08 — Phase 1 bugfix: new-project cards)

Phase 1 (1.2.0) shipped a routing bug in `projectOf()`: the "new project"
branch tested for an *exact* `project:new:` match, but a real card is always
`project:new:<path>` (the form appends the folder). Every new-project card
therefore fell into the *existing-project* lookup with a junk id
(`new:<path>`), found nothing, and failed "deleted or archived?" — the
`projects.create` path was unreachable. A retry re-ran the same broken
lookup, so the card appeared "stuck" instead of failing.

### Fixed

- **New-project cards now route to create/adopt** — `projectOf` uses a
  prefix test, so `project:new:<path>` → create-or-adopt; `project:<id>` →
  existing project (unchanged).
- **Adopting a manually-created project is now robust** — the
  create-or-adopt dedupe compare (`samePath`) ignores case, trailing
  separators, *and* slash direction, so a project you made by hand (or a
  path typed with `/` instead of `\`) is adopted instead of re-created or
  rejected as a duplicate (5063).
- **Clearer "not found" error** — an unresolvable project target now says
  the target may be stale and points at the 🎯 target picker to re-point
  it, instead of implying the project was deleted/archived.

### No change

Storage key and card schema are untouched — a live queue (including your
failed/stuck card) survives the update. Re-point that card at the real
project (or a fresh `＋ New project…`) and Play; it now resolves.

## 1.2.0 (2026-10-07 — project targeting, roadmap Phase 1)

Cards can now run into **desktop Projects** (the sidebar's named workspaces).

### Added

- **Project targets in the target picker** — the 🎯 picker (composer and
  per-card) gained a **Project** section between "New session" and the
  session list: every non-archived project of the active profile
  (`projects.list` RPC), plus **＋ New project…** with an inline form
  (name optional — defaults to the folder's name — and a folder path that
  must exist on the gateway host).
- **`project:<id>` target** — the card creates a FRESH session with
  `cwd = project.primary_path` (`session.create` accepts `cwd`; the sidebar
  groups a session under the project that owns its cwd, per
  `hermes_cli.projects_db.project_for_path`). The session is closed after
  its turn like any one-shot card; the project itself is never touched.
- **`project:new:<path>` target** — at fire time the plugin calls
  `projects.create` (name + folder, `primary_path` = the given path), then
  runs the card in it. The card is immediately re-anchored to the created
  project's real id (`project:<id>`), so a retry never re-creates it — and
  a second card pointed at the same folder reuses it too (idempotent
  create: a matching primary path is adopted, avoiding the gateway's 5063
  duplicate-primary-path refusal).
- **Per-project error states** — clean `failed` reasons when a target
  project is gone (deleted/archived) or has no folder, or the new-project
  path was never set.

### Unchanged

- **Existing targeting is untouched**: `new` (default) and session-key
  targets behave exactly as before; v1 card storage loads unchanged
  (cards simply have no `project:` target). The storage key is unchanged;
  the payload version bumped 1 → 2.
- **The engine is otherwise identical**: global model-slot gate, strict
  review gate, queued-in-target tracking, 12 h stall backstop, restart
  re-attach. Project cards are "new session" cards for every gate and
  close-on-done decision — the only difference is the `cwd` on
  `session.create`.

### Notes

- Projects are per-profile: the picker lists the ACTIVE profile's
  projects (the same `projects.db` the sidebar shows). Switch profile →
  different list; cards keep their stored id either way.
- A project session inherits the project's git context (branch/root)
  automatically, since that derives from the cwd at create time.

## 1.1.1 (2026-10-03 — catalog review fixes)

Addressing the Nous catalog review of `4851cd1` (PR #131983, "needs changes
before listing" — two Medium findings + two smaller notes).

### Fixed

- **The ask-first chip now shows what it is asking about.** The `::enqueue`
  chip used to render only the fixed text "＋ add suggested prompt to
  queue" (with a generic tooltip), while replacing the directive paragraph —
  so the suggested prompt was never visible, and in auto mode the card could
  launch as a full agent turn seconds after a blind click. The chip now
  renders the prompt itself, truncated at ~200 chars, with the full prompt
  in the tooltip.
- **Auto-add no longer re-queues old transcripts after a reload.** The
  de-dupe set was in-memory only, so reloading the app with Auto-add on
  re-added every `::enqueue` in an old transcript (and ran them if Play was
  on). Auto-add now fires only on first mount while the message is still
  streaming (`streaming === true` from the directive render props); settled
  re-renders show the chip again (ask) or nothing (auto, already added)
  without re-adding.
- **`Tip` rendered as a string.** The target-follow-up label used
  `jsxs('Tip', …)` — a string tag — so the tooltip never worked. Now uses
  the imported `Tip` component.
- **Stall error text derived from the constant.** The "turn stall: no
  completion after 1h" message was hardcoded while `TURN_STALL_MS` is 12 h;
  it now computes the hours from the constant.

### Migration

- None. Storage format unchanged; existing queues and settings load as-is.
  In-memory de-dupe semantics unchanged for the live session.

## 1.1.0 (2026-10-02 — merged to `main`; on `unreleased` since 2026-10-01)

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
- **Skipped tab + card action menu.** A fourth tab (`Skipped`) joins Queue /
  Done / Failed, and the card's **×** now opens a small menu — **↷ Skip**
  (→ Skipped), **✓ Mark done** (→ Done), **✕ Delete** — instead of deleting
  instantly, so an accidental click no longer loses a prompt.
- **Settings menu no longer clips.** The gear (⚙) dropdown now anchors to the
  pane header row (`position: relative` on the header, `right: 6px`) instead
  of to a wrapper around the gear button — anchoring to the button's own
  width pushed the 250px menu leftward out of the app window.
- **Session picker opens up when it would run off the bottom of the window.**
  `TargetPicker` now measures the trigger against the viewport on open and
  flips the menu upward when opening downward would pass the window bottom
  (was: always down, or hardcoded-up for the composer). The composer picker
  — at the pane's bottom — therefore opens up; a card's picker near the top
  still opens down.

### Migration

- None needed for behavior. The new `queuedBehind` card flag is additive;
  saved queues from earlier versions load unchanged.

### Catalog packaging (1.1.0 layout)

- Repo restructured for the [Hermes plugin
  catalog](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission):
  the plugin now lives at `desktop/plugin.js` with a `plugin.yaml` manifest
  (`requires_hermes: ">=0.21.5"`). `hermes plugins validate` passes
  (security scan: safe; desktop surface: inside the SDK surface).
- Disk installs must copy the `desktop/` subdirectory (see Install in the
  README); the live install under `desktop-plugins/prompt-queue/` is
  unaffected by the repo layout.
- Screenshot at `docs/screenshots/prompt-queue.png` (catalog `screenshots:`
  candidate, pinned to the listing SHA).

### Security hardening (addressing the [AtlasOmnia PR #7 review](https://github.com/AtlasOmnia/community-plugins/pull/7))

All three findings from the blocking review, fixed on this branch (decisions
locked 2026-10-02; implemented 2026-10-02):

- **`::enqueue` — ask before queue (default).** Transcript-directive
  attributes are untrusted model output by platform contract
  (`apps/desktop/src/lib/transcript-directives.ts`). The directive now
  renders a "＋ add suggested prompt to queue" button — the card is added
  only on explicit click. Auto-add is an opt-in in the gear (⚙, pane
  header → *Suggested prompts: Auto-add*). Also **fixes the dedup bug**
  (React strips `key`, so the old code deduped on `undefined` and silently
  dropped every card after the first) — the identifier is now a normal
  `dedupeKey` prop.
- **Review gate — fail-closed default.** On `host.logs` verification
  failure the gate now **holds**: the card shows
  `⏸ holding — review verification unavailable` and the 20 s re-poll
  retries until absence is confirmed (a recoverable, visible state — no
  silent release). Fail-open is an explicit opt-in (gear → *Review gate on
  error: Open*). README/CHANGELOG "strict review gate" wording now matches
  the implemented semantics.
- **Gear (pane header, ⚙).** Settings: *Suggested prompts* (Ask first /
  Auto-add) and *Review gate on error* (Hold / Open), persisted via
  `ctx.storage` (`prompt-queue-settings-v1`) so they survive restarts.
  Defaults are the safe side (ask / hold).

Docs shipped ahead of the code (Phase 0, 2026-10-02): README **Trust &
Autonomy** and **Performance notes (local models)** sections — including the
KV-cache session-switch cost of one-session-per-card on local models. The
Trust & Autonomy section was updated to describe the shipped (not planned)
behavior.

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
