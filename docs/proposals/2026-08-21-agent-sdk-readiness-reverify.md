# Agent-SDK readiness — re-verification pass (2026-08-21)

> **Status:** Written 2026-08-21 against branch HEAD `c48e5cb`; §7 records a
> follow-up refactor landed later the same day at the maintainer's request. The
> scheduled audit routine re-ran the standing question — "review
> the agent core, model handler, logger, and surface for unnecessary abstraction
> and unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the two immediately-prior passes
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md) at `391033e`,
> [`-08-20`](./2026-08-20-agent-sdk-readiness-reverify.md) at `74fab00`). This
> pass re-derived the verdict from four independent area audits (core, model
> handlers, logger/telemetry, surface + subagents) rather than a diff of the
> prior entry, and reached the **same conclusion by an independent route**: the
> alignment **holds**. Every `-08-20` tracked fact re-verifies at `c48e5cb`; the
> frozen host deep-import lists are unchanged (no narrowing this window, no
> widening); the only surface delta is the version bump 0.40.3 → 0.40.4.
> **No abstraction to remove.** The verification found nothing to refactor at
> `c48e5cb`; the only code landed this session is the mechanical barrel
> consolidation §7 records — the shovel-ready deep-import shrink §4.3 named,
> executed afterward at the maintainer's request. §2's counts are the `c48e5cb`
> snapshot before that change; §7 carries the after. Every claim below carries a
> `file:line`, config path, or count checked at `c48e5cb`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, no structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** Four fresh area audits this pass each
independently reported the same thing the prior passes did — the pass-through
wrappers, convenience barrels, and single-caller factories the standing question
hunts for are, with only borderline exceptions, not present, and several sites
carry comments recording a prior collapse. The 15 merges since `74fab00` (see
§5) add no wrapper layers; two are indirection-removing refactors (#11170
dead-code gate made single-authority; #11229 typed creator tool groups) and one
narrows a settings seam (#10945 reader/writer split). A speculative edit into
this tree with the verdict already green would be net-negative.

## 1. Every `-08-20` tracked fact re-verifies at `c48e5cb`

| Item                               | `-08-20` state                         | `c48e5cb` state                                                                                                                                              |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L-3** (dead redaction branch)    | closed; `redactSecrets` single-arg     | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                   |
| **L-2** (process-global log sink)  | module-singleton, deliberate           | **unchanged.** `channels` / `mainOutputChannel` / `outputChannelFactory` / `outputSinksTrusted` at `src/logger/logUtils.ts:54-57`; no `platform().log` port. |
| **C-1** (ambient ALS in cycle)     | closed by #10594 (`ToolPolicy` field)  | **still closed.** `readonly toolPolicy: ToolPolicy` present (`src/agent/core/flows/BaseFlowServices.ts:56`).                                                 |
| **§6b** in-process multi-tenancy   | deliberate; throws on 2nd platform     | **unchanged, correctly.** Guard intact — "already using another platform in this process" (`packages/agent/src/index.ts:243`). Maintainer decision.          |
| **M-3** `ModelHandler.ts` god-base | 2,068 LoC                              | **still 2,068 LoC** (`wc -l`). Genuinely shared behavior; a long-horizon port-narrowing note, not a discrete removal.                                        |
| **Logger-core line counts**        | logUtils 256 / redaction 101 / cT 82   | **unchanged** (256 / 101 / 82).                                                                                                                              |
| **Node flow engine**               | single ~150-LoC file                   | **153 LoC** (`src/agent/node/index.ts`), `BaseNode`/`Flow` only. Matches CLAUDE.md.                                                                          |
| **Version**                        | 0.40.3 (`runFact.` retirement → v0.41) | **0.40.4.** Still short of the v0.41 gate; retirement not yet due.                                                                                           |

## 2. Frozen host deep-import width — unchanged, no widening

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-08-19` | `-08-20` | `c48e5cb` |
| ------------------- | -------- | -------- | --------- |
| cli                 | 12       | 11       | **11**    |
| desktop             | 10       | 9        | **9**     |
| extension           | 13       | 12       | **12**    |
| agent (SDK package) | 7        | 7        | **7**     |

The one-per-host narrowing seen in the `-08-19 → -08-20` window was a one-time
convergence; this window's merges landed elsewhere, so the counts hold flat. The
set-based ratchet still forbids any new edge. `agent`'s 7 sits near the realistic
floor bounded by the provider-type-leak constraint (§4.2).

## 3. Subagent boundaries — still already drawn, and mature

Re-confirmed independently this pass. The subagent boundary is **not** a future
design task — it is a shipped, multi-implementor abstraction:

- **The contract** is `ChildRunStrategy<TTurn>` + `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts:102-295`) — a deep module with a narrow,
  turn-based interface (`launch` / `runTurn?` / `isTerminal` / `formatDelivery`
  / …; upward channel is just `notify(progress)` + `recordCost(usd)`).
- **Proof it is at the right altitude:** five independent implementors satisfy it
  — in-process TeXRA agent (`src/tools/delegation/nativeSubagentStrategy.ts`),
  workflow-script children (`workflowScriptStrategy.ts`), external agent CLIs
  (`src/tools/agentCliShared.ts`), background bash processes (`src/tools/bash.ts`),
  driven by the owner `childRunLoop`.
- **The recursion-closing seam** is the `AgentEngine` runtime slot provided at
  `src/agent/runtime/executeAgent.ts` (`provideAgentEngine`), deliberately a
  load-time slot rather than a static import to break the
  `registry → DelegationTools → executeAgent → registry` cycle.
- **The launch/output contract** is `SubagentRunOptions`
  (`src/agent/runtime/executeAgent.ts:303-339`) in, `AgentFlowResult`
  (discriminated `toolUse | workflow`) out.

Of the six named candidate units, the honest mapping is: **reflection and
tooluse are already the agent-category dispatch axis** (`executeAgent`
branches on `agentCategory`); **followUp and goal are substrate, not agents**
(turn delivery and prompt assembly); **review is a support library behind a
tool-use YAML agent**; and **only `agentCreator` is a genuine "logical agent not
yet running as one"** — it runs inline in the extension host via an
`AgentCreatorUI` port and is the deepest specifier in the baseline
(`@agent/implementations/agentCreator/agentCreatorFlow`). No new boundary to
invent; the SDK work is to _document_ `ChildRunStrategy` / `AgentEngine` /
`SubagentRunOptions` as the canonical subagent SPI, not to design one.

## 4. Remaining open items (all pre-existing, none a defect)

Carried forward from `-08-20 §4`, with two refinements this pass added concrete,
verified detail to. All remain out of scope for a "land now" change.

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, not a mechanical cleanup.
2. **Logger + telemetry are process-global singletons with no public plug
   point.** L-2 (log sink) plus `UsageLogService`
   (`src/telemetry/UsageLogService.ts:396`, a module singleton owning a queue,
   flush timer, and hardcoded Supabase endpoint). A consumer embedding
   `@texra-ai/agent` cannot supply its own logger or usage sink through any
   sanctioned surface — the only log entry point is the frozen deep import
   `@logger/logUtils`. The SDK-correct answer is an injectable owner for both
   (a logger context threaded through `AgentTrace`/`SessionHandle`; a `UsageSink`
   port that hosts register), which then unlocks a Tier-1 `configureLogging` /
   `configureUsage`. Proposal work, not churn — same theme as north-star
   "logger → event stream".
3. **Shrinking the frozen deep-import lists — the concrete next mechanical
   step is barrel consolidation.** _Landed this session — see §7._ Verified
   this pass: `src/agent/export/`,
   `src/agent/review/`, and `src/agent/templates/` have **no `index.ts` barrel**,
   so hosts reach leaf modules directly — cli into `@agent/export/{loadChatExportInput,schemas,chatExportFormatter}`,
   extension into `@agent/review/{reviewDiff,reviewIssues}` and
   `@agent/templates/agentTemplateRenderer`. Adding those three barrels (plus
   fronting `agentCreatorFlow` and `core/state/executionRequests`/`TaskState`
   behind existing doors, and widening `@agent/index` to cover
   `platformAgentDirectories` / `agentRegistry` / `BundledAgentDirectories`)
   converts the de-facto surface into an **8-door Tier-1 manifest**
   (`index, runtime, storage, trace, followUp, export, review, templates`) and
   shrinks the baseline in the same PR. This is ~80% "add three barrels + widen
   two", ~20% new design — the ratchet's stated welcome direction. Not landed
   here (verification-only pass), recorded as the shovel-ready next step.
4. **Provider-SDK type leak is the floor on `agent`'s specifier count** — the
   shared `IModelHandler` port is parameterized by `SdkToolCall`
   (`src/agent/types/ModelHandlerContracts.ts`), whose `raw` field imports
   concrete types from `openai`, `@google/genai`, `@anthropic-ai/sdk`, and
   `@openrouter/sdk` (verified at `ModelHandlerContracts.ts:12-19`). The only
   reason those provider imports sit on the neutral contract is that one `raw`
   member. Narrowing `raw` to `unknown` (narrowed inside each provider folder) or
   behind a per-provider generic is the one structural cleanup that would let a
   published surface expose `IModelHandler` without dragging all four provider
   `.d.ts` graphs into every consumer's typecheck. A decision for manifest-design
   time, not a blind pre-refactor; `scripts/validate-artifacts.mjs` already
   guards the leak on the built package.
5. **`shared-schemas-deep-import`** remains effectively sealed — one documented
   floor entry (`@shared/schemas/log`), `forced`/`gratuitous` both empty. No
   action.
6. **L-1 tail** — the ~7 log-only `createChannelTrace` sites could be narrowed
   onto `createLog` one at a time. Low value; the only genuine small candidate
   left, not worth a dedicated PR.
7. **Publication** remains gated on packaging/legal and the named-external-
   consumer hold, not on API shape.

## 5. Merges since the `-08-20` pass (`74fab00..c48e5cb`)

15 merges; none add a wrapper layer. Notable: #11170 (dead-code gate made
single-authority), #11229 (typed creator tool groups), #10945 (settings
reader/writer evidence split), #11224 (shared pasted-image chip assembly),
#10676 (extension activation-failure lifecycle drain), GLM-5.3 via llm-zoo
1.29.0, the Claude Agent SDK bump with task-tools preservation (#11243), and the
0.40.4 version bump + dependency-group bumps. All either neutral or
indirection-reducing — consistent with the standing trend.

## 6. Bottom line for this pass

Nothing to refactor. Three consecutive passes (`-08-19`, `-08-20`, `-08-21`) now
find a green verdict; this pass reached it by re-deriving from four independent
area audits rather than diffing the prior entry, and the two refinements it adds
(the shovel-ready barrel-consolidation step in §4.3, and the precise mechanism of
the provider-type-leak floor in §4.4) sharpen the open record without changing the
verdict. The verification pass itself found no abstraction to remove; the one code
change this session is the mechanical barrel consolidation in §7, landed at
the maintainer's request as the shovel-ready step §4.3 named.

## 7. Landed refactor — three Tier-1 barrels (this session)

At the maintainer's request, the consensus shovel-ready step from §4.3 was
executed rather than only recorded. This is a behavior-preserving surface
change: no runtime logic moved, only the doors hosts import through.

**Added** three curated public-surface barrels, each documented in the house
style of `@agent/followUp` / `@agent/runtime` and re-exporting exactly the
symbols the hosts consume (no new dead exports):

- `src/agent/export/index.ts` — `loadChatExportInput`, `formatChatAsMarkdown`,
  type `ChatExportInput`.
- `src/agent/review/index.ts` — `collectReviewDiff`, `isPathInChangeSet`,
  `listBaseBranchCandidates`, `createReviewIssue`, `normalizeReviewFilePath`,
  `buildReviewInstruction`, `buildFixInstruction`, and the `ReviewIssue` /
  `ReviewIssueReport` / `ReviewSeverity` types.
- `src/agent/templates/index.ts` — `renderAgentTemplateString`.

**Re-routed** the six host import sites (cli `runtime/history.ts`,
`commands/history.ts`; extension `frontend/review/{AgentReviewService,
promptReviewOptions,AgentReviewTreeProvider}.ts`,
`commands/agent/agentCreatorCommands.ts`) from the leaf specifiers to the
barrel doors.

**Shrank** `config/ratchets/host-agent-import-baseline.json` accordingly — the
five leaf specifiers (`@agent/export/{loadChatExportInput,chatExportFormatter,
schemas}`, `@agent/review/{reviewDiff,reviewIssues}`) plus
`@agent/templates/agentTemplateRenderer` are gone, replaced by the three doors
`@agent/export`, `@agent/review`, `@agent/templates`:

| Package   | before | after  |
| --------- | ------ | ------ |
| cli       | 11     | **9**  |
| extension | 12     | **11** |
| desktop   | 9      | 9      |
| agent     | 7      | 7      |

Three of the eight planned Tier-1 doors (§4.3) now exist. **Validation:**
`npm run typecheck` exit 0; `hostAgentDeepImportRatchet.vitest.ts` green (no
new edge, no stale headroom, baseline sorted); `check:dead-code-ratchet` no new
findings; eslint + prettier clean; the full `src/test-kernel/architecture/`
suite passes (104/104). The remaining doors (`export`/`review`/`templates` now
done; `agentCreator` fronting and the `@agent/index` widening for
`platformAgentDirectories` / `agentRegistry` / `BundledAgentDirectories`) stay
open per §4.3 as they carry a design decision, not just a mechanical move.
