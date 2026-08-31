# Agent-SDK readiness — re-verification pass (2026-08-31)

> **Status:** Written 2026-08-31 against branch HEAD `c89c63e`
> (`fix(workflow): recover moved call progress by journal position`, #11705). The
> scheduled audit routine re-ran the standing question — "review the agent core,
> model handler, logger, and surface for unnecessary abstraction and unready
> surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), landed with its §4a/§4b
> removals executed in §8). Like every pass since `-08-19`, this one re-derived the
> verdict from **four fresh, independent area audits** (core, model handlers,
> logger, surface + subagents) rather than a diff of the prior entry. It reached the
> **same top-line verdict by an independent route — the alignment holds** — and this
> time surfaced **no new shovel-ready removal**: the one candidate that looked
> parallel to a known dead export was run to ground against the live `knip`
> ratchet and confirmed a non-finding (§4). Every claim below carries a
> `file:line`, config path, or count checked at `c89c63e`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present. The exemplary deep modules the prior passes named — `ModelCell`,
`SessionEventHub`, `PersistedFlow`, `ChildRunStrategy`, `ModelInvocationNode` —
each re-verified as untouched-in-shape at HEAD. The two `-08-25` removals stayed
removed (§1). Every measured motion since `-08-25` was readiness-positive: the
frozen deep-import lists **shrank on one more host** (cli 8→7, §2), and
`ModelHandler.ts` shrank another 13 lines (§1). What is new this pass is **a
resolved uncertainty, not a finding**: an exported `vscodelm` helper that looked
structurally identical to a baselined dead export was verified — by running the
authoritative `knip` production ratchet — to be correctly green and not a
removal candidate (§4).

## 1. Every `-08-25` tracked fact re-verifies at `c89c63e`

| Item                               | `-08-25` state (`51c04c6`)                          | `c89c63e` state                                                                                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **§4a removal** (`OutputChannelFactoryOptions`) | landed (§8a): narrowed to non-exported `interface`  | **still narrowed.** `interface OutputChannelFactoryOptions` (no `export`) at `src/logger/logUtils.ts:48`; sole use the internal param at `:198`. |
| **§4b removal** (`SessionHandle.useHostInteractions`) | landed (§8b): method deleted, callers re-routed     | **still gone.** `grep useHostInteractions src/ packages/` returns nothing; callers use `session.interactions.use(...)`.               |
| **L-3** (dead redaction branch)    | closed; `redactSecrets` single-arg                  | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.            |
| **M-3** `ModelHandler.ts` god-base | 2,043 LoC                                           | **2,030 LoC** (`wc -l`); −13. Genuinely shared behavior, no per-provider copy-paste (README's "shared, not duplicated").             |
| **Provider-type-leak floor**       | `M`/`T` leak all four provider SDKs                 | **unchanged.** `ProviderMessage.ts:4-8` still imports message types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`. |
| **Node flow engine**               | 159 LoC, `BaseNode`/`Flow` only                     | **158 LoC** (`src/agent/node/index.ts`); still exactly `BaseNode` + `Flow` (2 `export`s). Matches CLAUDE.md.                          |
| **SDK entry files**                | index / node / schemas                              | **stable.** `index.ts` 322, `node.ts` 67, `schemas.ts` 49 LoC; export sets unchanged (§3).                                            |
| **Version**                        | 0.40.5 (short of the v0.41 gate)                    | **0.40.7.** Advanced two patches; still short of the v0.41 retirement gate. Retirement not yet due.                                   |

## 2. Frozen host deep-import width — shrank on one more host, held on the floor

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package, past the `@agent` barrel):

| Package             | `-08-25` | `c89c63e` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

`cli` shed one specifier (8→7) — the "shrink the frozen lists" work advancing, not
a widening. The set-based ratchet still forbids any new edge and fails on stale
headroom, so the lists can only shrink or hold; the "never widen a baseline"
invariant remains structurally enforced. `agent`'s 7 remains at its realistic
floor, bounded by the provider-type-leak constraint (§5.2): the surface audit
re-confirmed that `@agent/runtime/AgentFlowResult` cannot collapse into the
`@agent/runtime` barrel without dragging `ModelCell`/`ProviderMessage`'s provider
SDK types into the emitted `.d.ts` and tripping
`scripts/validate-artifacts.mjs`.

## 3. Surface & subagent boundaries — re-confirmed by two independent audits

**SDK surface.** The three published subpaths (`.` → `index.ts`, `./schemas` →
`schemas.ts`, `./node` → `node.ts`, `packages/agent/package.json` exports map)
each carry a curated public export set with **no orphaned member**: the run entry
`runAgent(RunAgentInput): AgentRun` plus its tool-facing set (`ITool`,
`MapToolRegistry`, `defineTool`, `DefinedToolClass`) that backs the
`tools?: readonly ITool[]` option; `schemas.ts` is 100% re-export by design (the
dedicated validation entry point); `node.ts` exposes only `NodePlatformOptions` +
`nodePlatform()`. `HostInteractions` is `cancel()`-only — the deliberate minimal
shape, not a finding. No surface growth beyond the documented run + schemas +
platform triad.

**Subagent SPI — a shipped, multi-implementor boundary, not a design task.**
`ChildRunStrategy<TTurn>` / `ChildRunPorts` (`src/agent/runtime/childRunLoop.ts`)
is driven by **five production implementors**, matching the header enumeration:
in-process TeXRA agent (`src/tools/delegation/nativeSubagentStrategy.ts:201`),
workflow-script children (`src/tools/delegation/workflowScriptStrategy.ts:160`),
Claude CLI and Codex CLI (both via the shared factory
`src/tools/agentCliShared.ts:515`, consumed at `claudeAgent.ts:69` and
`codex.ts:65`), and background bash (`src/tools/bash.ts:249`). The recursion-closing
`AgentEngine` slot (`provideAgentEngine`/`engine()`, filled at
`nativeSubagentStrategy.ts:77-120`) still severs the
`registry → DelegationTools → executeAgent → registry` cycle.

**`agentCreator` remains the one genuinely-open boundary, and correctly open.**
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`)
has a single production caller (`agentCreatorCommands.ts:184`), invoked inline via
the `AgentCreatorUI` port rather than through `runAgent`/`ChildRunStrategy`. Closing
it is interactive-UI design work (the approval/UI channel the public
`HostInteractions` deliberately lacks), not a mechanical fold — so it stays open by
design, and is the `extension` baseline's deepest specifier.

## 4. Investigated and resolved this pass — one non-finding, run to ground

The model-handler/logger audit raised one low-confidence observation worth pinning
down: `foldSystemPromptIntoVscodeLmMessages`
(`src/agent/modelHandlers/vscodelm/modelHandlerVscodeLm.ts:114`) is an `export`ed
function whose **only cross-file importer is a vitest** (`ModelHandlerVscodeLm.vitest.ts:10`),
with in-file production callers at `:309` and `:503`. That is the same shape as the
**baselined** dead export `PROVIDER_KEY_REDACTION_RULES` (`src/logger/redaction.ts:28`,
in `config/ratchets/knip-baseline.json:1484`) — used in-file at `redaction.ts:75`,
imported only by `DesktopLogRedaction.vitest.ts`. The open question was whether the
dead-code ratchet was **red at HEAD** (a missing baseline row) or whether `knip`
credits the two differently.

**Resolved: the ratchet is green and consistent.** Running the authoritative gate
(`npm run check:dead-code-ratchet`, with deps installed) reports
`6 normal, 315 production; 315 combined … vs 315 baselined — no new findings`. A
filtered production `knip` run confirms it flags the `const`
`PROVIDER_KEY_REDACTION_RULES` but **not** the `function`
`foldSystemPromptIntoVscodeLmMessages` — `knip` credits the latter's in-file
method-body usage, so it is a live production symbol whose `export` is a deliberate
unit-test seam (the same category the standing question exempts for the logger's
free `debug`/`info`/`warn`/`error` functions). **Not a removal candidate, and the
baseline needs no new row.** The apparent structural parallel does not translate to
a `knip` finding.

No other new dead export surfaced: the model-handler sweep found only the six
already-baselined zero-external-importer symbols, and the logger surface added none
beyond the `-08-25` state.

## 5. Remaining open items (carried forward, none a defect)

These are unchanged from `-08-25 §5` and remain design-gated decisions, not
mechanical cleanups. Re-stated in brief so this entry stands alone:

1. **Model-handler port shape.** `IModelHandler` (`src/agent/types/IModelHandler.ts`)
   is a hand-maintained `Pick<ModelHandler<…>>`. Deriving from the concrete base is
   the correct anti-drift choice internally; a *public* SDK manifest would want the
   port defined intrinsically. A manifest-design note, not a defect.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.**
   `ProviderMessage.ts` still imports the four providers' message types; `T`
   (`call.raw`) is load-bearing at `ToolUseDispatchNode.ts` display-fallback sites
   and must route through a handler method before the leak can close.
   `scripts/validate-artifacts.mjs` already guards the built package.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a `UsageSink`
   port) behind Tier-1 doors, specified in
   `docs/prds/2026-05-06-prd-logger-v2.md` and deferred behind singleton-retirement.
   The dual public entry surface (`createLog` vs the free level-writers) stays — the
   free functions are the `loggerSelf` test-spy seam.
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (§3, blocked on the interactive `AgentCreatorUI` design) and a
   `core/state` door (blocked because a dynamic `import()` would leave the leaf live
   for zero ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision. The public shape stays minimal (`cancel()` only) until the
   approval channel has a stable contract.
6. **Result-taxonomy documentation.** Documenting *why* `WAITING` exists and *why*
   `cost`/`diffs` land only on `AgentFinalResult` remains the single largest
   "which result do I get?" clarification the surface needs.
7. **Publication** remains gated on the named-external-consumer hold; the legal side
   cleared earlier (Apache-2.0 relicense, PocketFlow NOTICE, ToS scoping).

## 6. Bottom line

This is the sixth consecutive pass (`-08-19` through `-08-31`) to find a green
top-line verdict, re-derived from four fresh independent area audits. The honest
answer remains "almost nothing to remove," and this pass had **nothing new to
record**: the two `-08-25` removals stayed removed, `ModelHandler.ts` shrank
another 13 lines, the frozen deep-import lists shrank on one more host (cli 8→7),
and the one candidate that looked removable was run to ground against the live
`knip` ratchet and confirmed a non-finding. Nothing warrants a speculative edit
into the green tree. The remaining structural work is unchanged and design-gated:
the two open Tier-1 doors, the injectable logger/usage ports, the `IModelHandler`
manifest decision, and result-taxonomy documentation.
