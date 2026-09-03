# Survey: code consolidation and native-method opportunities (2026-09-03)

> **Status:** Written 2026-09-03 against branch HEAD `d418d45` (`refactor:
delete five dead surfaces in the runtime and CLI approval layers`,
> #11792). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — one day after
> `2026-09-02-consolidation-and-native-methods-survey.md`. **Verdict: nothing
> new survives scrutiny.** No code changes accompany this entry.

## 0. Why this pass is targeted rather than a full re-sweep

Six full simplification survey rounds (2026-08-25 through 2026-08-27) and
three prior dedicated passes on this exact question (2026-08-29, 2026-08-30,
2026-09-02) already swept the repo end-to-end and found nothing outstanding
in either lens. Between 2026-09-02's grounding commit (`646475d`) and this
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
- **Hand-rolled sleeps:** zero in production `src/`/`packages/*/src/`
  (all remaining hits are `src/test-kernel/**` timer-flush fixtures) — same
  conclusion as every prior round.
- **`JSON.parse(JSON.stringify(` deep clones:** the one production hit,
  `src/agent/workflowScript/parseScript.ts:130`, remains the already-adjudicated
  `vm.Script` sandbox literal, not a clone helper. No new hits.
- **`.indexOf(...) !== -1` / dedup-via-filter-and-indexOf:** zero.
- **Hand-rolled `Math.random().toString(36)` IDs:** zero in production (one
  hit, in a `test-kernel` fixture).
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
- **Hand-rolled `debounce`/`throttle`:** zero.
- **New `Object.assign(` call sites in the diff:** none of the 93 touched
  production files added one; the repo-wide set is unchanged from the prior
  round's already-accepted "mutating an owned, function-local object" pattern.
- **Per-provider subscription-quota detection files (4 files, one new
  reference this round):** each file's distinguishing signal is genuinely
  different — GLM matches a numeric `code` field plus a `Asia/Shanghai`
  timestamp parse, Kimi Code matches a request-endpoint stamp plus a message
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
  that would otherwise pin a long-lived source signal's listener graph for the
  source's whole lifetime. This is consolidation _arriving_, not a
  duplication left behind — nothing further to flag.
- **CLI approval dispatch (`packages/cli/src/runtime/approvalAdapter.ts`,
  `packages/cli/src/runtime/approval/approvalPrompts.ts`):** already collapsed
  in this window (part of #11792, not #11775) from a
  `CliDecisionApprovalRequest` discriminated-union dispatch into one
  `decideGated` helper taking an already-computed settlement plus prompt
  content — the exact shape a fresh survey would otherwise propose.
- **Cross-host duplication (CLI / desktop / extension):** the "message-host
  trio" consolidation (#11754) and "share agent-proposal wiring across
  hosts" (#11756) already landed in this window; the remaining per-host
  files read in this pass (`desktopAgentExecution.ts`,
  `ProgressViewMessageHandler.ts`, `chatSessionController.ts`) each own
  host-specific wiring (Electron IPC, VS Code webview messages, terminal
  rendering) with no shared logic duplicated across them beyond what the
  existing base classes already cover.

## 3. Verdict

No candidate in either lens clears the bar the six prior full-repo rounds and
the three prior dedicated passes on this exact question set. As with
2026-09-02, the volume of upstream `refactor:`/`consolidate:` commits landed
in the 28-commit window between surveys (eleven explicitly targeting this
class of work — nine consolidation refactors plus two dead-code deletions,
enumerated in §0 — several landing the exact shape a fresh pass would
otherwise propose) is itself evidence the surface this routine watches is
being actively worked, not neglected.

This entry exists to record that the routine ran and to save the next pass
from re-treading the same ground; no code changes accompany this cycle.
