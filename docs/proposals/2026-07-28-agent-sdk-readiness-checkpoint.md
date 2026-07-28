# Agent SDK Readiness — Verification Checkpoint (2026-07-28)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-27-agent-sdk-readiness-checkpoint.md`](./2026-07-27-agent-sdk-readiness-checkpoint.md),
the empirical package cut
[`2026-07-27-agent-npm-package-step3.md`](./2026-07-27-agent-npm-package-step3.md)
(the current Step-3 plan of record), the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](./2026-07-26-agent-sdk-foundation-gap.md),
the audit of record
[`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](../dev/audits/2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-07-27` checkpoint chain.

This pass inspected the tree afresh at HEAD `1882a78` (`CHANGELOG.md` heading
`[0.39.9] - 2026-07-26`). The `-07-27` checkpoint pin `55ee72b` **is** an ancestor
(`git merge-base --is-ancestor` succeeds); `git rev-list --count 55ee72b..HEAD`
reports **60 commits**. This pass re-inspected the tree at HEAD and reconciled
against the standing record; it did not perform a commit-by-commit audit of that
range. It ran a fresh three-way structural sweep of the areas the task names
(agent core, model handlers, logger, host→core surface) to test whether any new
indirection has accreted that the standing record does not already track.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available** (no second-pass reviewer). It therefore
applies **no code change** — see "No change lands." The discipline is the one the
`-07-22` `MapToolRegistry` revert established and every checkpoint since has held:
structural changes of this class need a reviewer outside the pass's own analysis,
which an unattended run lacks. The `-07-27` checkpoint is the worked example that
even a grep-clean "obviously dead" field (`taskType`) is correctly deferred by the
unattended pass and applied only after a maintainer re-derives it in an attended PR
(commit `5c2b81f`).

## Verdict — well-aligned; the shape is unchanged and the plan is now empirical

**The codebase remains well-aligned and SDK-ready in shape. No new structural
refactoring is warranted this pass.** The core-shape conclusion every checkpoint
since `-06-26` reconverges on holds unchanged.

**The one genuinely new fact vs. `-07-27`:** the Step-3 packaging question moved
from "gated on a real external consumer" to an **empirical, measured plan**. The
maintainer posited that consumer (2026-07-27) and #9307 landed
[`2026-07-27-agent-npm-package-step3.md`](./2026-07-27-agent-npm-package-step3.md),
which reports a real package-cut experiment: **the 719-file candidate set typechecks
in isolation with 38 escape sites, zero `vscode` imports across 556 floor files.**
The layering work is done; what remains is *deciding where the product line falls*
(5 ranked blockers, 5 maintainer decisions), not untangling. This is the strongest
evidence to date that the years of decoupling paid off, and it reframes the whole
program: "Agent SDK readiness" is no longer an open structural question — it is a
bounded packaging-and-rulings project with a compiler-verified cost estimate
(weeks-to-internal, months-to-public, the months being decisions not code).

## Spine invariants — re-verified at HEAD `1882a78`

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`),
  still auto-derived, not hand-written — a surface-shape observation, not drift.
- `Node.exec → createFlow().run` shape intact: `ResponseCycleNode.exec()` creates
  and runs `createResponseCycleFlow<C>()` inline, no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`, `model`,
  `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`, `hosts`,
  `logger`).
- Ratchets present and enforcing: `host-agent-import-baseline.json`,
  `knip-baseline.json`, `architecture-edges-baseline.json`,
  `shared-schemas-deep-import-baseline.json`, `host-agent-mock-baseline.json`.
- `IToolRegistry = { get, has }` (`src/agent/core/tools/ToolTypes.ts:41`) — still
  closed, no public `register`. `MapToolRegistry` still `Map | Record` with the
  `instanceof Map` branch (`:50-51`) — the reverted `-07-22`/`-07-23` state,
  correctly not re-attempted.
- `agentCreatorFlow.ts` still contains **0** `Node`/`Flow`/`@agent/node` references —
  a linear async function, not a flow; CLAUDE.md's "not a flow" note is accurate.

## Landed since `-07-27` — the 60-commit delta

Verified present at HEAD by subject line + presence-in-tree (not a per-PR diff review):

| Item | Landed as | Effect |
| ---- | --------- | ------ |
| Sever the `@tools/registry` import cycle at the remote-agent client (B1 progenitor) | `e1559fc`, #9343 (#9327) | the closed+cyclic tool-registry blocker (Step-3 B1) is being unwound at the edge; `RemoteAgentLoader` shrank 253→~40 lines with the list split into `remoteAgentList.ts` |
| Delegation-spine cleanup — unify child cost settlement, share native child execution path, dedupe native launch | `875f6ad`, `cf0b171`, `3e3c80c`, #9339 | the subagent dispatch path (native / in-band / workflow-script strategies) consolidated |
| Workflow-script dispatch made reliable; duplicate-call cost isolation | `c352524` (#9309), `1143030`, `22274bb` | workflow subagent orchestration hardened |
| Remove dead `taskType` plumbing | `2696d1d` (#9303) | the `-07-27` deferred dead field, applied after maintainer re-derivation |
| The `-07-27` SDK-readiness checkpoint itself | `2696d1d` (#9303) | recorded |
| **#9307 — the `@texra-ai/agent` Step-3 package proposal + `docs/architecture/embedding-the-agent-runtime.md`** | `79ce6e8` | the empirical package cut; the headline of this pass |
| `progressView` flush timer → shared `createFlushableDebounce` | `328999e` (#9304) | hand-rolled timer removed |
| Fold `agent/` micro-suites into canonical module suites | `43a14c9` (#9253/#9306) | test hygiene |
| `externalToolDefs` prerequisites-check wiring factored | `be9c21b` (#9302) | tool-def wiring tidied |
| `defineTool` return-type fix (declaration-emit prep, Step-3 B4) | #9346 | the TS4094 class the B4 spike predicted is being pre-empted |

Net: the delta is continued **reviewed-PR** progress on exactly the Step-3 blockers
(B1 registry cycle, B4 declaration emit) and the subagent-delegation spine. The
readiness gap keeps closing through the correct channel.

## This pass's structural sweep — findings mapped to the record

A fresh three-agent sweep of agent core, model handlers, and logger surfaced a
list of indirection candidates. The value of recording them here is to mark **which
are already tracked** (do not re-file) versus **which are genuinely fresh** (candidate
cleanup, gated behind attended review). None is applied this pass.

### Already tracked by the standing record — no new action

- **`IModelHandler` 44-member width / `SdkToolCall` vendor-type embedding.** Step-3
  §5c: "v0 exports nothing, packaging does not force the split"; 42 of 43 picked
  members are called from core/flows, so narrowing means redesigning the flow↔provider
  boundary (the measured net-add class). Standing strategic item.
- **Anthropic-SDK features re-implemented in a provider-neutral base** (hand-rolled
  stream demux `AnthropicStreamHandler`, manual `cache_control`/beta bookkeeping,
  client-side `runClientCompaction` coexisting with the server compaction beta). Real,
  but the abstraction's value *is* the multi-provider fan-out the single-provider Agent
  SDK does not cover — this is by-design, not debt. Consistent with north-star §2.
- **No enforced host→core package boundary; `@agent/*` deep specifiers.** North-star
  NS-1 + Step 0/3. The one-directional ESLint gate (core-may-not-import-host) is the
  enforced half; the reverse (host-may-import-any-core-file) is intentionally unfenced
  until the Step-3 package draws the line. Step-3 §3 names the three entries
  (`@texra-ai/agent`, `/schemas`, `/node`) that will.
- **Product leaks on the runtime launch path** — `preferHelperModel`
  (`runAgent.ts:54`), `compileFailures` on the flow result, `toolConfig` LaTeX booleans.
  Foundation-gap §9 / Step-3 §6 ("what v0 does not include"). Design ruling, not tidying.
- **`stateOwnership` tail — still 8 live non-test references** (`ProgressBackend`,
  `ProgressViewState`, `desktopAgentExecution.ts:259`). `-07-27` acceptance-row-1 tail,
  gated behind a real ruling.

### Genuinely fresh this pass — candidate cleanup, gated (recorded, not applied)

These did not appear verbatim in the checkpoint chain I read. Each is small and
plausibly correct; each also fits the class the `-07-22` revert warns about (a
grep-clean "obviously safe" move that can hide an incomplete caller census). Record;
do not apply unattended.

1. **`agentCreatorFlow.ts` is misfiled under `implementations/flows/`.** It is not a
   PocketFlow (0 `@agent/node` refs — confirmed) but a linear `runAgentCreator` wizard.
   CLAUDE.md already documents "despite the directory and filename it is not a flow," so
   the *fact* is known; the **relocation** (e.g. to `implementations/agentCreator/`) is
   the fresh suggestion. Cosmetic, single production caller — low value, low risk, but a
   real "the tree lies about what this is" wart.
2. **`persistedFlow.ts` v1-compat carry-over** — `FlowRecord.params` (always `{}` in
   practice, `:46-52`) and `replayLegacyNodePath` (`:406`) are legacy-cursor fallbacks
   eligible for removal at a `FLOW_RECORD_SCHEMA_VERSION` bump (currently 2). A schema
   bump on persisted, resumable data is exactly the "needs a compatibility boundary"
   class — not an unattended edit.
3. **Pass-through model-handler subclasses.** `ModelHandlerDashScope`
   (`openai/modelHandlerDashScope.ts`) is a 14-line class whose entire body flips one
   flag (`convertContentToString = true`); `ModelHandlerXAI`'s `extractResponse` override
   exists solely to emit a debug log before returning `super`'s result. Candidates to
   collapse into a capability bit — but each also carries a factory route + compatibility
   key, so "collapse the class" is not a one-file change. Note, don't touch.
4. **`refreshClient` (`ModelHandler.ts:1129`)** is a pure forward to `getClient` kept
   only to give the retry layer a differently-named entrypoint; **`withCreateResponseGuard`**
   is the identity function for every provider except OpenAIResponse. Micro-indirection;
   real, sub-threshold.
5. **`src/agent/trace/helpers.ts`** — 17 single-primitive forwarders over `AgentTrace`
   (`logSdkError`→`logErrorData`, `logFileCategory`→`logFilesLoaded`, …), each collapsing
   to one `trace.*` call. Per the CLAUDE.md "collapse pass-through layers / single-caller
   extractions are banned" rule this is the highest-count fresh cleanup target — but it
   needs a per-helper caller-count census before any removal, which is precisely the
   attended-review work.

### Verified NOT a defect

The core sweep flagged a possible "double lease capture" — `captureOwnedExecutionLease`
called in both `runAgent.ts:117` and `executeAgent.ts:377` for the same `executionId`.
Checked the implementation (`src/agent/storage/executionLease.ts:507-534`): the function
validates the ambient owner token against the live lease generation and re-runs the same
ownership map inside a nested AsyncLocalStorage scope. Because `executeAgent` is **also**
a standalone entry point (subagent dispatch, resume paths), it must self-capture; when
nested under `runAgent` the inner call is a validated re-affirmation of the same token,
not redundant work or a race. Deliberate and correct — no action.

## Subagent boundaries (task step 4) — already answered

The task asks to "identify logical units that could run as independent agents." The
repo already has this as a **first-class, actively-refactored** subsystem — the
`src/tools/delegation/` strategies (`nativeSubagentStrategy`, `inBandSubagentExecution`,
`workflowScriptStrategy`) plus the `workflowScript/` engine — and the delegation spine
was consolidated this very window (#9339). The *SDK-facing* subagent split point is
already mapped empirically by Step-3 §1-2: **20 generic tools (18,649 LoC) vs 34
domain tools (14,834 LoC)**, connected only through `registry.ts`, `externalToolDefs.ts`
(5 edges) and one `PlanTool → @tools/goal` edge. That generic/domain cut — not a new
agent decomposition — is the boundary the package draws. No fresh split-point proposal
is warranted; the measured one supersedes any paper sketch.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`. The lowest-risk fresh
candidates above (the `agentCreatorFlow` relocation, the `helpers.ts` forwarder census)
were **not applied**: each is either sub-threshold or needs a caller census that only an
attended reviewer reliably completes. `MapToolRegistry` re-checked and still `Map | Record`
with the `instanceof Map` branch — **do not re-attempt the narrowing** without a deliberate
compatibility boundary for `Map` inputs.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 60-commit `55ee72b..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record. The "Landed" table is
  verified by presence-in-tree plus commit subject, not by reviewing each PR's diff.
- The Step-3 package-cut numbers (38/53 escapes, 719/556 files) are quoted from
  #9307's proposal, not independently re-run this pass.
- Counts beyond the directly-grepped spine invariants (`stateOwnership` = 8,
  `IModelHandler` member width, tool split LoC) are re-derived or quoted, not re-audited
  to full forensic scope.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the texra.ai
  publish allowlist) — not a root-level doc, so it does not touch the `docs-root-boundary`
  gate.
