# Survey: code consolidation and native-method opportunities (2026-09-03)

> **Status:** Written 2026-09-03 against branch HEAD `d418d45` (`refactor:
delete five dead surfaces in the runtime and CLI approval layers`,
> #11792). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — one day after
> `2026-09-02-consolidation-and-native-methods-survey.md`. **Verdict: no
> duplication newly introduced in this window, but PR review on this entry
> surfaced three real, pre-existing candidates from
> `2026-08-25-cli-controller-seam-audit.md` that three prior survey passes
> (2026-08-29, 2026-08-30, 2026-09-02) and this entry's own first draft all
> failed to file, plus a fourth new hand-rolled-sleep hit this entry's own
> sweep missed — filed as #11809, #11810, #11811, and #11812. #11809's
> initial "leaked composite" framing was itself disproven by a later review
> pass plus an empirical GC test and has been corrected (§2).** No code
> changes accompany this entry.

## 0. Why this pass is targeted rather than a full re-sweep

Six full simplification survey rounds (2026-08-25 through 2026-08-27) and
three prior dedicated passes on this exact question (2026-08-29, 2026-08-30,
2026-09-02) _reported_ nothing outstanding in either lens — a description
this entry's own §3 revises: three real, applicable candidates from the
2026-08-25 audit had gone unfiled through all of them, surfaced only by this
entry's own PR review. Between 2026-09-02's grounding commit (`646475d`) and
this
one, 28 commits landed, 23 of them touching `src/` or `packages/*/src/` (the
other five are docs-only, dependency bumps, or a workspace pnpm version
alignment) — and, as with the prior window, a large share of that volume was
itself
already-completed consolidation work: `refactor: give two swallow-and-log
policies a single owner` (#11784), `refactor: use date-fns for log timestamp
formatting` (#11777), `Replace custom cache with LRUCache in
SubscriptionUsageService` (#11778), `refactor: consolidate quota-limit types
and drop a hand-rolled sleep` (#11779), `refactor(shared): consolidate
wa-icon construction onto waIcon()` (#11781), `refactor(hosts): consolidate
the message-host trio into one interface` (#11754), `refactor:
subscription-usage reuse existing utilities over hand-rolled logic`
(#11755), `refactor: share agent-proposal wiring across hosts, key
warned-set by stream` (#11756), `refactor: share the staged-deletion
rollback path and the sr-only recipe` (#11775), and two dead-code deletions
(#11788, #11792). Given that volume of upstream simplification work already
targeting this exact question, this pass re-ran the standard native-method
tells against current HEAD and read the 28-commit diff's production files
for newly introduced duplication, rather than re-deriving the prior full-repo
rounds' conclusions from scratch.

## 1. Method

- Repo-wide `rg` sweeps of `src/` and `packages/*/src/` (production code
  only, test-kernel excluded) for the classic tells: `.hasOwnProperty(`,
  hand-rolled `setTimeout`-based sleeps (`new Promise(resolve =>
setTimeout(...))`), `JSON.parse(JSON.stringify(` deep clones, `.filter(...)`
  dedup via `.indexOf(...)`, `.indexOf(...) !== -1` in place of `.includes(`,
  hand-rolled `Math.random().toString(36)` ID generation, hand-rolled
  `isEqual`/`deepEqual` functions, hand-rolled attempt-counter `for` loops,
  hand-rolled `debounce`/`throttle` definitions, and new `Object.assign(`
  call sites.
- Read of every production file touched between `646475d` and `d418d45`
  (`git diff --stat`, non-test files only — 93 of the 127 changed files) to
  check for newly introduced duplication the tells above would miss (e.g. two
  host adapters re-solving the same dispatch shape).
- Targeted read of the four per-provider subscription-quota detection
  modules (`chatgptSubscriptionDetection.ts`, `glmCodingPlanDetection.ts`,
  `kimiCodeSubscriptionDetection.ts`, `xaiSubscriptionDetection.ts`) — the
  one area in the diff window that visually resembles repeated per-provider
  boilerplate — against their shared `errorInspection.ts` /
  `sdkRequestEndpoint.ts` helpers.

## 2. What was checked and ruled out

- **`.hasOwnProperty()` direct calls:** zero repo-wide.
- **Hand-rolled sleeps:** the sweep's regex required `setTimeout` as the
  direct executor body and missed two production hits with a nested or
  wrapped form. `src/platform/defaults/lifecycleHost.ts:70-72`:
  `new Promise<void>((resolve) => onAbort(signal, () => setTimeout(resolve, 0)))`,
  raced against a shutdown-phase promise. Structurally not a plain sleep —
  the delay only starts once `signal` aborts, giving shutdown handlers one
  macrotask to settle after the abort fires, not a fixed wait from now — so
  it is not a direct `node:timers/promises` `setTimeout(ms)` swap without
  restructuring the abort-then-yield sequencing. Plausibly intentional, but
  should have been enumerated rather than reported as test-only.
  `packages/extension/src/frontend/latex/openBuild.ts:234-255`'s
  `scheduleViewerDisplay`, by contrast, _is_ the plain case: an unconditional
  `new Promise<boolean>((resolve) => setTimeout(async () => { ... resolve(...) }, ms))`
  in the Node-based extension-host frontend, straightforwardly rewritable as
  an `async` function awaiting `node:timers/promises`' `setTimeout`. A real
  miss, not an accepted exception — filed as #11812. All other
  remaining hits are `src/test-kernel/**` timer-flush fixtures — same
  conclusion as every prior round for those.
- **`JSON.parse(JSON.stringify(` deep clones:** the one production hit,
  `src/agent/workflowScript/parseScript.ts:130`, remains the already-adjudicated
  `vm.Script` sandbox literal, not a clone helper. No new hits.
- **`.indexOf(...) !== -1` / dedup-via-filter-and-indexOf:** the sweep's
  regex missed the assignment-in-condition form; one real hit exists,
  `src/replacement/advanced.ts:329`:
  `while ((startIdx = text.indexOf(env.start, startIdx)) !== -1)`. This walks
  every occurrence of a math-environment delimiter and needs the matched
  _position_ to advance past it, so `.includes()` does not apply — not a
  candidate, but should have been enumerated rather than reported as zero.
- **Hand-rolled `Math.random().toString(36)` IDs:** zero in production (two
  hits, both in the same `test-kernel` fixture —
  `src/test-kernel/agent/runtime/ChildRunLoop.vitest.ts:106,114`).
- **Hand-rolled `isEqual`/`deepEqual`:** zero.
- **Hand-rolled attempt-counter `for` loops:** the recurring
  `MAX_DIRTY_WRITE_RETRIES` durability-flush loop already traced to
  `SidecarWriteCoordinator.retryDirtyWrites` in the 2026-09-02 round did not
  change shape in this window. One genuinely new instance: `e599027`
  (#11762) adds a `MAX_EVICTION_DRAIN_ATTEMPTS` loop to
  `StreamSnapshotStore.requestEviction` (`src/transcript/StreamSnapshotStore.ts:1203`).
  Read in full: each iteration awaits the record's in-flight seed chain and
  `retryDirtyWrites`, then re-checks the record's identity (generation,
  seed-chain reference, ownership, a caller liveness check) before evicting;
  it loops (bounded at 3 attempts) only when a write lands on an
  already-seeded record during the drain, re-armed by a fresh mutation, not
  because an operation failed. No `catch`, no backoff, no error
  classification — the same "bounded re-drain reconciling concurrent state,
  not `p-retry`-shaped error-driven retry" species as
  `MAX_DIRTY_WRITE_RETRIES`, adjudicated the same way. Not a candidate.
- **Hand-rolled `debounce`/`throttle`:** the sweep's regex required the
  literal function name `debounce`/`throttle` and missed
  `createFlushableDebounce` (`src/utils/core/index.ts:256`, pre-existing, not
  new this window). Its own doc comment states the reason a library
  debouncer doesn't fit: call sites need a synchronous flush escape hatch
  (run the pending call now, typically pre-teardown) and re-entrant
  `schedule()` from inside the callback itself — the CLI's transcript sync
  re-schedules from within its own flush callback, which `es-toolkit`'s
  invoke-then-cancel debounce silently drops. An accepted exception, not a
  candidate, but should have been counted rather than reported as zero.
- **Defensive-copy-then-iterate of a mutated collection:** not one of this
  survey's stated tells, but a related native-construct nit surfaced by
  review: `packages/cli/src/chat/chatSessionController.ts:372` iterates
  `[...liveOwnerships]`, a spread copy of a `Set`, so that each
  `ownership.release()` call (which deletes only _that_ ownership from the
  live `Set`, confirmed by reading the callback at line 414) can safely
  mutate the collection mid-loop. Deleting the current element during a
  `Set` iterator's traversal is well-defined, so the copy is unnecessary —
  `for (const ownership of liveOwnerships)` would do. Real, correct, and
  genuinely tiny (one allocation removed, no behavior change); not filed as
  a separate issue per this survey's own bar for thin candidates, and out of
  scope for a docs-only PR to fix inline.
- **New `Object.assign(` call sites in the diff:** none of the 93 touched
  production files added one; the repo-wide set is unchanged from the prior
  round's already-accepted "mutating an owned, function-local object" pattern.
- **Per-provider subscription-quota detection files (4 files, one new
  reference this round):** each file's distinguishing signal is genuinely
  different — GLM matches a numeric-looking string `code` field (via
  `pickStringField`, tested against a `ReadonlySet<string>`, e.g. `'1310'`)
  plus a `Asia/Shanghai` timestamp parse, Kimi Code matches a request-endpoint
  stamp plus a message
  regex, xAI matches a credential-route stamp plus a different message
  regex, ChatGPT/Codex matches a `type` discriminant field. All four already
  route their common parts (`errorBodyCandidates`, `pickStringField`,
  `pickNumberField`, `matchUsageLimitMessage`, `detectSdkRequestBaseURL`,
  `detectSdkCredentialRoute`) through the shared `errorInspection.ts` /
  `sdkRequestEndpoint.ts` modules. Forcing the remaining provider-specific
  matching into one table-driven function would trade four short, readable,
  independently-testable files for one function branching on
  provider-specific field shapes — a net readability loss for no duplication
  removed. Not a candidate.
- **New `linkAbortSignals` helper (`src/utils/core/index.ts`):** a genuinely
  new shared abstraction added in this window (used by `src/tools/timeouts.ts`
  and elsewhere), replacing per-call-site `AbortSignal.any([...])` composites
  in cases where an application-level listener stays attached to the
  composite indefinitely — that pattern does pin the composite (and its
  source-side listener) for as long as the source lives, verified below.
  `src/auth/fetchWithTimeout.ts:10-23` builds an undetached
  `AbortSignal.any([options.signal, controller.signal])` on every call, which
  looked like the same shape at first read. **It is not**, verified
  empirically (Node v22, `--expose-gc` + `FinalizationRegistry`): a composite
  built the same way and passed straight into a real `fetch()` call _is_
  collected once the request settles, even with the long-lived source signal
  still alive and never aborted, because `fetch`/undici removes its own
  internal abort listener from the given signal once the request completes —
  and once that listener is gone, nothing else keeps the composite reachable.
  `fetchWithTimeout`'s composite is handed to `fetch` and touched by nothing
  else, so it does not leak. (A first pass of this doc asserted the leak
  and filed #11809 on that basis; a second Codex review pass challenged it,
  the empirical test above confirmed the challenge, and #11809 has been
  corrected to drop the leak claim while keeping the still-valid,
  independent finding: `fetchWithTimeout` hand-rolls a timeout
  `AbortSignal.timeout()` already covers, for one consumer.)
- **CLI approval dispatch (`packages/cli/src/runtime/approvalAdapter.ts`,
  `packages/cli/src/runtime/approval/approvalPrompts.ts`):** already collapsed
  in this window (part of #11792, not #11775) from a
  `CliDecisionApprovalRequest` discriminated-union dispatch into one
  `decideGated` helper taking an already-computed settlement plus prompt
  content — the exact shape a fresh survey would otherwise propose.
- **Cross-host duplication (CLI / desktop / extension):** the "message-host
  trio" consolidation (#11754) and "share agent-proposal wiring across
  hosts" (#11756) already landed in this window, but neither happened to
  touch one pre-existing pair: `desktopAgentExecution.ts:521-524` and
  `ProgressViewMessageHandler.ts:661-664` each build
  `ProgressFollowUpController` with a byte-identical `workspace: {
locatePath, exists }` adapter wrapping the same two `WorkspaceFS` static
  methods. Also already named, unfiled, in the 2026-08-25 seam audit ("Ten
  inline snapshot-port re-projections... plus a byte-identical `workspace`
  pair"). Filed as #11810. `chatSessionController.ts` (CLI) owns unrelated
  terminal-rendering wiring with no shared logic duplicated against either
  host file. A second pair also survived this window's host consolidations:
  `desktopAgentResume.ts:50-116` and `resumeFromResumeData.ts:19-70` run an
  identical six-step resume-result skeleton (already named, unfiled, as the
  2026-08-25 audit's C11 row), and `810abdc` (#11789, in-window) reinforced
  it by adding the same new `requestShowInstruction` settlement block to
  both files independently rather than to one shared implementation. Unlike
  the workspace-adapter pair, C11 carries an explicit caveat blocking a
  silent fold — desktop's skeleton has a `hasAuthoritativeStream` precheck
  the extension's lacks, so unifying is a behavior decision, not a
  mechanical dedup ("Flag explicitly; do not fold silently," per the audit).
  Filed as #11811 with that decision named as the prerequisite.

## 3. Verdict

No _newly introduced_ duplication in the `646475d..d418d45` window clears the
bar the six prior full-repo rounds and the three prior dedicated passes on
this exact question set. As with 2026-09-02, the volume of upstream
`refactor:`/`consolidate:` commits landed in the 28-commit window between
surveys (eleven explicitly targeting this class of work — nine consolidation
refactors plus two dead-code deletions, enumerated in §0 — several landing
the exact shape a fresh pass would otherwise propose) is itself evidence the
surface this routine watches is being actively worked, not neglected.

That said, this entry's own PR review is itself the counter-example to
treating "nothing new" as "nothing outstanding": three real candidates from
`2026-08-25-cli-controller-seam-audit.md` (`fetchWithTimeout`'s reimplemented
`AbortSignal.timeout`; the byte-identical desktop/extension `workspace`
adapter; the desktop/extension resume-result skeleton, reinforced by a new
copy-pasted block in this very window's `810abdc`) had gone unfiled through
this entry's first draft and all three prior dedicated passes, surviving
purely because nobody had turned the audit's table rows into tracked issues.
Review also caught a fourth, independent miss in this entry's own sweep:
`scheduleViewerDisplay` (`openBuild.ts`) hand-rolls the exact `new
Promise(resolve => setTimeout(...))` sleep pattern this survey's tells
target, in production code the regex's executor-body assumption didn't
match. Review process caught itself, too: this entry's _own_ first
adjudication of the `fetchWithTimeout` finding claimed its composite signal
leaked the same way `linkAbortSignals` was built to prevent; a second Codex
pass challenged that, and an empirical GC test (§2) proved the challenge
right — `fetch`'s own listener cleanup means it doesn't leak. #11809 is
corrected accordingly. All four filed issues are low-risk; the
resume-skeleton pair (#11811) carries a real behavior decision the audit
itself flagged and this entry preserves rather than silently resolving.
Filed now as #11809, #11810, #11811, and #11812 — the actual output of this
round.

This entry exists to record that the routine ran and to save the next pass
from re-treading the same ground; no code changes accompany this cycle, but
four follow-up issues do.
