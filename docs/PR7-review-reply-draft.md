# Draft reply — AtlasOmnia/community-plugins PR #7 (NOT posted)

Status: draft, 2026-10-02. To be posted **only after** the `unreleased`
hardening is complete, verified, and (if Arthur decides) merged to `main`, so
the linked repo shows the fixed code. Reviewer: @AtlasOmnia.

---

Thanks for the careful review — all three findings check out, and we've
fixed each on the `unreleased` branch of
[vectorforge22/prompt-queue](https://github.com/vectorforge22/prompt-queue).
We'll merge to `main` (so the linked repo reflects the fixes) once the branch
is verified; commits will be linked below.

**1. Untrusted assistant output can enqueue executable work — accepted, fixed.**
You're right, and we agree with the framing: transcript-directive attributes
are untrusted model output by the platform contract, so the `::enqueue`
path must not auto-execute. The directive now adds a *pending* card that
requires an explicit user click to accept before it can ever be drained;
auto-add survives only as an opt-in in the plugin's new settings (gear in
the pane header). The plugin README also gained a **Trust & Autonomy**
section documenting the trust model (user-typed cards vs. model-suggested
cards) so users can assess the plugin's autonomy surface.

**2. Directive deduplication broken (`key` as a prop) — accepted, fixed.**
Confirmed: React does not forward `key`, so the dedupe Set keyed on
`undefined` and every directive after the first was silently dropped. The
identifier is now passed as a normal `dedupeKey` prop.

**3. Strict review gate fails open — accepted, fixed.**
`reviewCleared()` returned `true` on any `host.logs` error, releasing the
queue during a transient failure. The gate now **holds** (fail-closed) with a
visible "review verification unavailable" state and auto-retry until absence
is confirmed; fail-open is kept as an explicit user opt-in in the settings.
We've also corrected the "strict review gate" wording in the README to match
the implemented semantics rather than advertise it.

We also added a **Performance notes** section to the README: on local-model
setups, one new session per card carries a KV-cache (re)load cost, and the
card-target feature lets users point iterative work at one existing session
to reuse its context.

Thanks again for the review — it made the plugin meaningfully safer for
people running it against untrusted content.

---

## Pre-post checklist (internal — delete before posting)

- [ ] Phases 1–3 merged to `unreleased`, verified (real node.exe, .mjs copy)
- [ ] `unreleased` → `main` merge done (or Arthur explicitly posts against
      the `unreleased` branch ref)
- [ ] Commit SHAs for each of the three fixes linked in the body above
- [ ] Arthur approves the final wording
