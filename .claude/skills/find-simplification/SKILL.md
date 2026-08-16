---
name: find-simplification
description: 'Use when working in the TeXRA repo to find non-obvious simplification candidates and record them as dated proposals or tech-debt issues; especially for dead exports, duplicated lifecycle machinery, expired compatibility readers, speculative generality, over-built seams, added-then-removed features, or hand-rolled code that a Node builtin or an existing dependency already covers.'
---

# Finding TeXRA Simplifications

This skill turns a broad "find things to simplify" request into evidence-backed proposals that remove or collapse existing surface area. It is guidance, not a checklist: follow the code, keep judgment active, and prefer a few well-proven candidates over a pile of thin guesses.

## Start With Repo Context

- Read `AGENTS.md` — especially "Code quality rules" (earned from the 2026-07 simplification campaign), "Pragmatic implementations", "Discouraged factory patterns", "Flattening abstraction layers", "Compatibility and format retirement", and "Testing discipline". These are the standing rules a simplification proposal is judged against.
- Read the review-checklist sections that encode past over-corrections: [§13 abstraction-cost guardrails](../code-review/references/review-checklist.md) (the Refactor-LOC lesson: 22 "reduction" PRs netted +5,046 LoC) and §14 fewer-elements rulings (R1, R5–R8). A proposal that would net-add elements needs its justification built in from the start.
- Skim `docs/architecture/` before judging anything under `src/agent/`, `src/platform/`, or the PocketFlow flows; simplifications that fight the host/agnostic split or the event-ownership model need extra evidence. `docs/proposals/` and `docs/dev/audits/` record settled design decisions — check them before proposing to collapse a seam.
- Check the tech-debt tournament ledger issue (LionSR/TeXRA#8974) for the do-not-do list, and search `is:issue label:tech-debt` (open and closed) before writing anything new — a recently rejected or already-filed candidate is a duplicate, not a find.

## Settled Surfaces — Do Not Propose Collapsing

Treat these as intentional by default; removing an unused method *inside* one can still be valid, but collapsing the seam itself must beat the recorded rationale:

- The four checked-in ratchets under `config/ratchets/` (`host-agent-import`, `shared-schemas-deep-import`, `host-agent-mock`, `architecture-edges`). Baselines freeze remaining edges — they shrink, never widen. Proposing to *shrink* one is a good candidate; proposing to delete the ratchet mechanism is not.
- The frozen `@agent/*` SDK surface (`packages/agent/`). There is no `@texra/core` workspace package (deleted by #7099); do not propose recreating it.
- The trimmed PocketFlow engine (`src/agent/node/index.ts`). It deliberately lacks upstream `BatchNode`/`BatchFlow`, parallel variants, and the `params` channel — do not propose re-adding them, and do not propose replacing the engine without reading it first.
- The four hosts (extension, desktop, CLI, trace-viewer) and the platform-ports composition root. Desktop has had no public release, which makes desktop state a *simplification* source (no migration machinery allowed), not a target.
- The seven browser-reachable `@utils/*` modules enforced by `scripts/check-browser-safe-utils.mjs`. The constraint is intentional; reducing the reachable set is welcome, adding Node built-ins to it is a regression.

## What Counts As A Strong Candidate

A strong simplification removes, folds, or demotes something real and has clear evidence that the current design costs more than it buys:

- An exported symbol, command, config key, event, manager method, or packaged resource has no production consumer. The dead-export ratchet (`npm run check:dead-code-ratchet`, per-symbol baseline in `config/ratchets/knip-baseline.json`) already knows about grandfathered ones — a *new* dead export, or proof that a baselined one can now leave the baseline, is the find.
- Tests or docs are the only consumers, and the behavior they pin is not load-bearing. Per "Testing discipline", tests pinning retired behavior get deleted with the behavior, not rewritten around the new implementation.
- Compatibility machinery past its window: readers, aliases, migrations, or dual-format unions whose replacement shipped more than three months ago. "Compatibility and format retirement" makes these deletable by policy — cite the introduction date comment beside the compat code.
- Two representations mirror the same fact — e.g. a fact derivable upstream that is instead re-derived by a `resolve*`/`derive*`/`infer*` helper at multiple call sites (checklist §15 names the precedents).
- Speculative product generality with no product owner: multi-workspace abstraction used by one workspace, configurable registries with one registration, staged-migration scaffolding whose tail never closed.
- A wrapper, facade, or factory that only relocates complexity: single-caller extractions, trivial identity factories, two-layer factories called once, convenience barrels with no documented public surface.
- Hand-rolled code reimplementing a Node builtin at the repo's engine floor (ES2022+, see "ES2023+ Patterns" in `AGENTS.md`) or an *existing* root dependency — `p-queue` for serialized async work is the canonical case (`chain = chain.then(...)` chains are banned going forward).
- Desktop-only migration or compat code: desktop state always adopts the current format directly, so any desktop migration machinery is dead on arrival.
- The simplified behavior may differ slightly, but the new behavior is still reasonable and easier to explain.

Thin candidates are not enough: deleting one typo, a single `knip` run's raw output, reformatting, or "this looks complex" without call-site proof.

## Survey Broadly

Use parallel subagents when the user asks for breadth or many candidates. Give each agent a domain and require evidence, not guesses. Useful domains for this repo:

- Agent runtime and PocketFlow: flows, nodes, retry/fallback hooks, session resume paths, `src/agent/runtime/`.
- Model handlers and tools: `src/agent/modelHandlers/<provider>/`, `src/tools/`, delegation, tool schema defaults.
- Platform and hosts: port interfaces versus their actual consumers, `src/hosts/`, per-host wiring in `packages/*/`.
- Webviews: the three parallel view trees (`webview`, `progressView`, `settingsView`) — duplicated manager or slice logic across them is a recurring find, but keep their directory structures aligned.
- Storage and compatibility: `src/common/storage/`, persisted-state schemas, format readers with introduction dates.
- Packages, scripts, resources: `packages/extension/resources/`, `scripts/`, `prompts/`, `supabase/functions/` — splits and inventories that outlived their consumer.

If subagents are unavailable, simulate the same breadth yourself. Do not let the first good candidate stop the survey. Start with the largest production-code deltas; an audit that stops after obvious unused symbols misses the files where duplicated lifecycle or defensive machinery carries most of the cost.

## Audit Trust And Lifecycle Boundaries

For every defensive copy, freeze, validator, and callback capture, name where the value came from and who owns it next. "Trust your inputs" is repo policy: transform or validate only at true boundaries (user input, external APIs, persisted files, wire decoders). Same-process typed handoffs that deep-clone or re-validate are candidates; tests built around hostile getters or mutation after a same-process handoff are evidence of a speculative contract, not automatic justification for keeping it.

For complex asynchronous code, map each sentinel, readiness promise, cancellation path, disposer, and state flag to a distinct owner. When several mechanisms mirror the same liveness or settlement fact, propose one owner. Preserve machinery that protects first-terminal-outcome arbitration, process/worker ownership, or dispose-to-quiescence — and check any catch/fallback you touch against checklist §15's taxonomy before calling it removable; masking sites (M1–M6) are defects to fix, not elegance to delete.

## Hand-Rolled Code Versus A Dependency

This repo's default runs the other way from most: "Pragmatic implementations" prefers native constructs and JSON over new libraries, and a new dependency is never added silently. So the swap question is usually: does a **Node builtin at the ES2022 engine floor** or a **dependency the repo already has** cover this? `p-queue` (already a root dependency) replacing hand-rolled promise chains is the standing example. Prefer `.toSorted()`, `.at()`, `Object.hasOwn()`, `node:timers/promises`, and friends over local helpers.

A genuinely *new* dependency can still be the right answer, but the proposal must name the exact surface the package covers, check maintenance/adoption/transitive footprint honestly, and weigh net deletion (implementation plus dedicated tests plus docs, minus remaining glue). For webview-reachable code, a dependency that pulls Node built-ins into the browser-safe set is disqualified outright. A wrapper that relocates the same complexity is not a win.

## Prove Or Reject Each Candidate

For every symbol or behavior, classify consumers before writing:

- Production corpus: `src/`, `packages/*/src`, `packages/extension/resources/`, `prompts/`, `supabase/functions/`, and loader/config paths (`package.json` contributions, settings schema, command registration).
- Non-production corpus: `src/test-kernel/`, docs, `slides/`, snapshots, comments.
- Ambiguous corpus: `scripts/` and `docs/scripts/` — some are release/CI tooling that counts as production. Inspect usage before classifying.

Use `rg` first: the exact symbol, `.name(` and `name(`, command IDs and config keys as string literals, event names, and any wire strings. VS Code command contributions and settings keys are consumed through `package.json`, not imports — grep both. `npm run check:dead-code` (knip) can help, but it is not a substitute for reading public interfaces, dynamic event names, tests, and docs. When a ratchet baseline lists the symbol, the find is proving the baseline entry can shrink, not discovering the dead code.

Reject or downgrade a candidate when:

- A production caller exists and the simplification would be a feature decision rather than a cleanup.
- The design is explicitly justified by a dated proposal in `docs/proposals/`, a ratchet, or a hard-won rule in `AGENTS.md`/the review checklist, and the new evidence does not beat that reason.
- The removal would force unrelated churn without actually reducing the public API or required behavior (churn-class ban, checklist §14 R5).
- The idea is correct but tiny — batch it with related finds in one proposal or issue instead of standing alone.

## Record The Candidate

This repo has no inline-TODO convention and no notes tree; durable findings go to one of two places:

- **A dated proposal** under `docs/proposals/yyyy-mm-dd-topic.md` for a design-level simplification (collapsing a seam, retiring a format, replacing machinery). Follow the existing proposals' style: problem with consumer evidence, exact proposal, what we give up, acceptance criteria, risks.
- **A GitHub issue** labeled `tech-debt` for a bounded deletion, in the style of the tournament's children (e.g. #8746): title, evidence with `path:line` citations and grepped consumer counts, estimated net LoC and element delta, risk level. Dedupe against existing `label:tech-debt` issues (open *and* closed) first; consolidate into the existing issue that owns the topic rather than filing a duplicate.

Be concrete enough that an implementing PR can follow the trail. Avoid vague "simplify this package" write-ups. One proposal or issue per durable candidate; do not pad the count with thin finds.

## When Folding Another PR Or Branch

Diff the sibling branch against `origin/main`, not against the current PR branch, so you see its independent contribution. For each item:

- Port non-overlapping proposals or issues that meet the quality bar.
- Consolidate overlapping material into the existing proposal or issue that owns the topic.
- Do not port duplicate or lower-confidence candidates just to preserve the count.
- Update the PR body so reviewers see the true candidate count and scope.
- Close the duplicate PR only when the user asked you to, or when you clearly own that housekeeping.

## Validation And PR Hygiene

For docs-only proposal work, run `npm run format` and `git diff --check`. For code-touching implementation, run the checks AGENTS.md requires before committing: `npm run format`, `npm run compile:safe` (or targeted `typecheck:*` during development), `npm run lint`, `npm test`, and `npm run check:dead-code-ratchet` when exports were deleted (the baseline shrinks in the same PR).

A PR implementing a simplification is usually titled `refactor:` / `simplify:` / `consolidate:` / `dedupe:` — which activates the letter-level template requirements (checklist §14): the body must carry `## Net elements (R6)` (files, `^[+-]export` symbols, class/interface/enum declarations, net LoC from `git diff --stat origin/main`) and `## Consumer counts (R8)` (grepped subscriber/caller counts for every deleted emit path or public symbol). Build implies delete in the same PR; a net-positive-LOC "reduction" needs its stated reason. Use Conventional Commits.

When opening or updating the survey PR or reporting back, summarize:

- How many candidates were filed as proposals, filed as issues, consolidated into existing records, or rejected with evidence.
- The main areas surveyed.
- What was intentionally excluded (settled surfaces, do-not-do list entries).
- Which checks passed.

Use a draft PR while the survey is still expanding; mark ready only when the candidate set and validation are settled.
