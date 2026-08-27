# Agent-SDK readiness — re-verification pass (2026-08-27)

> **Status:** Written 2026-08-27 against branch HEAD `5af964e`
> (`test(tools): drop prompt-copy substring pins and per-tool guard duplicates`,
> #11470). The scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), written at `51c04c6`,
> whose §8 landed the two agreed removals). Like every pass since `-08-19`, this
> one re-derived the verdict from **four fresh, independent area audits** (core,
> model handlers, logger, surface + subagents) rather than a diff of the prior
> entry. It reached the **same top-line verdict by an independent route — the
> alignment holds** — and this pass is **pure green**: every prior tracked fact
> re-verifies, the `-08-25 §8` removals are confirmed still gone, and the audits
> surfaced **no new shovel-ready removal on the audited surfaces**. The one item
> below the removal bar (§4) is a test-only export already carried in the
> production-dead knip baseline, not a fresh finding. Every claim carries a
> `file:line`, config path, or count checked at `5af964e`.
>
> Consistent with the routine's default absent a maintainer request — matching
> the pure-green passes before `-08-22` — this run **records**, and lands nothing
> into the green tree unbidden. (`51c04c6` from `-08-25` is not in this branch's
> history — squash/rebranch — so tracked facts are re-derived at HEAD rather than
> diffed against that SHA.)

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** This is the **sixth
consecutive green pass** (`-08-19` through `-08-27`). The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are — with no exception on the audited surfaces this pass — not present. The
exemplary deep modules the prior passes named (`ModelCell`, `SessionEventHub`,
`PersistedFlow`, `AgentRunLifecycle`, `childRunLoop`, `ModelInvocationNode`) each
re-verified untouched-in-shape at HEAD. The two `-08-25 §8` removals
(`OutputChannelFactoryOptions` de-export, `SessionHandle.useHostInteractions`)
are **verified still gone**.

Three measured facts moved in the readiness-positive direction since `-08-25`:
the model-handler base shrank a further 11 lines (§1), the public `IModelHandler`
port shed 3 members (§2), and the 49-commit window (§6) is **100% refactor /
chore / fix** — dominated by deduplication and single-owner collapses, with
**zero new wrapper layers** on any audited surface. The frozen host deep-import
widths and the SDK package's 7-specifier floor are unchanged.

## 1. Every tracked fact re-verifies at `5af964e`

| Item                                | `-08-25` state (`51c04c6`)                        | `5af964e` state                                                                                                                          |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`-08-25 §8a`** (logger de-export) | landed: `OutputChannelFactoryOptions` local       | **still local.** `interface OutputChannelFactoryOptions {` with no `export` (`src/logger/logUtils.ts:49`); sole use is the internal param at `:191`. |
| **`-08-25 §8b`** (PT-2 removal)     | landed: `useHostInteractions` deleted             | **still gone.** `grep useHostInteractions src/ packages/` returns zero source hits (doc refs only). `SessionHandle` free of per-concern pass-throughs. |
| **`-08-22 §8` model-handler removals** | landed; base −26 LoC                           | **still gone.** `createToolUseFollowUpMessages` / `createAssistantMessageForPrefillText` — zero hits in `modelHandlers/` and `types/`. |
| **L-3** (dead redaction branch)     | closed; `redactSecrets` single-arg                | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.             |
| **L-2** (process-global log sink)   | module singleton, deliberate; no platform port    | **unchanged.** No `Platform.log` port (`src/platform/platform.ts:32-36` documents logging as a separate subsystem); sole host seam is `setOutputChannelFactory` (`logUtils.ts:189`), 2 callers, `console` fallback. |
| **M-3** `ModelHandler.ts` god-base  | 2,043 LoC                                          | **2,032 LoC** (`wc -l`); −11. 15 `abstract` members; no `instanceof`, no per-provider copy-paste (only config-enum branches at `:299,:651,:857`). Genuinely shared, not duplicated. |
| **Provider-type-leak floor**        | `M`/`T` leak all four provider SDKs               | **unchanged.** `ProviderMessage.ts:4-8` (the `M` default) and `ModelHandlerContracts.ts:4-7` (the `T` default) import message/tool-call types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`. |
| **Node flow engine**               | 159 LoC, `BaseNode`/`Flow` only                   | **159 LoC** (`src/agent/node/index.ts`); exactly `BaseNode` + `Flow` (2 exports). Matches CLAUDE.md.                                    |
| **`runFact.` prefix protocol**     | present as fact-key convention; v0.41 gate not due | **unchanged.** Survives only as a fact-key convention (`key: 'runFact.updateTodos'`); no literal `startsWith('runFact.')` wire protocol. |
| **Version**                         | 0.40.5 (short of the v0.41 `runFact.` gate)       | **0.40.6.** Advanced one patch; still short of the v0.41 retirement gate. Retirement not yet due.                                       |

## 2. Frozen host deep-import width — held on every host, model-handler port shrank

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package, past the `@agent` barrel):

| Package             | `-08-25` | `5af964e` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **8**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

All four held. The set-based ratchet forbids any new edge and fails on stale
headroom, so the lists can only shrink or hold; the "never widen a baseline"
invariant is structurally enforced. `agent`'s 7 remains at its realistic floor,
bounded by the provider-type-leak constraint (§5.2).

Separately, the model handlers' public port shrank: **`IModelHandler`'s
hand-maintained `Pick<ModelHandler<…>>` went 45 → 42 members**
(`src/agent/types/IModelHandler.ts:27-77`), consistent with the window's
"delete seven redundant surfaces across model handlers and auth" (#11435). No
member was added; the port only lost surface.

## 3. Subagent boundaries — still drawn, still mature (re-confirmed by two audits)

The subagent boundary is a **shipped, multi-implementor SPI, not a design task** —
re-confirmed independently by both the core and surface audits at HEAD:

- **Contract:** `ChildRunStrategy<TTurn>` (`src/agent/runtime/childRunLoop.ts:171`)
  + `ChildRunPorts` (`:104`) — a deep module with a narrow turn-based interface;
  the one loop (`startChildRunLoop`, `:759`, reached from exactly two call sites)
  owns everything a driver does not vary, and the strategy supplies only provider
  behavior.
- **Five independent implementors** drive that one loop:
  1. In-process native subagent — `nativeSubagentStrategy.ts:196`.
  2. Workflow-script children — `workflowScriptStrategy.ts:156`.
  3. Background bash — `bash.ts:252`.
  4. External Claude CLI — `claudeAgent.ts:440` via the shared factory
     (`agentCliShared.ts:497`).
  5. External Codex CLI — `codex.ts:406` via the same shared factory with
     Codex-specific turn execution.
- **Recursion-closing seam:** `provideAgentEngine(...)` — declared at
  `nativeSubagentStrategy.ts:102`, **filled at load time** by the engine module
  (`executeAgent.ts:703-706` provides `{ executeAgent, resumeToolUseTurn }`), a
  deliberate slot (not a static import) that severs the
  `registry → DelegationTools → … → executeAgent → registry` cycle. Ruled
  settled/frozen (`2026-08-16-services-injection-audit.md:199`): no PR may convert
  it to a parameter. (The provided member is `resumeToolUseTurn`, the *unlaned*
  turn — the child loop already holds the lane — correcting the field name cited
  in prior passes.)

**`agentCreator` remains the one genuine "logical agent not yet running as one".**
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts`)
runs inline through the `AgentCreatorUI` port (`:249-262`), not via
`runAgent`/`ChildRunStrategy`. **What blocks closing it is unchanged and
correct:** the flow is a sequence of *interactive host prompts*
(`promptAgentName`, `pickTools`, `promptAddToConfig`, …), i.e. multi-turn
human-in-the-loop UI, not an autonomous instruction→result turn. The
`ChildRunStrategy`/`HostInteractions` contract has no interactive-prompt channel
yet — the same gap that keeps the public `HostInteractions` at `cancel()`-only
(§5.3). Closing it is interactive-UI design work, not a mechanical move.

## 4. New this pass — one below-bar cleanup, no clean removal on the audited surfaces

The four fresh audits found **no pass-through/facade method, no single-caller
wrapper, and no redundant port** on the agent core, model handlers, or SDK
surface. The only item any audit surfaced is below the removal bar:

### 4a. `PROVIDER_KEY_REDACTION_RULES` — test-only export, already tracked

`src/logger/redaction.ts:28` exports `PROVIDER_KEY_REDACTION_RULES`, whose **only
consumer is a test** (`src/test-kernel/desktop/DesktopLogRedaction.vitest.ts`).
Production code flattens only its `.patterns` once into `PROVIDER_KEY_PATTERNS`
(`redaction.ts:73-79`); the per-rule `.examples` metadata exists solely to feed
that test. It is **already carried in the production-dead knip baseline**
(`config/ratchets/knip-baseline.json:1868`), so it is a *known, tracked* dead
export, not a fresh finding.

- **Why not landed this pass:** it is not a clean behavior-preserving removal —
  collapsing the `export` means relocating the per-provider example strings into
  the test to preserve its coverage, which is a small refactor with a coverage
  caveat, not a mechanical de-export. Absent a maintainer request, the routine
  records it rather than pushing into the green tree. (Contrast `-08-25 §8`,
  which landed at explicit request.)

Every other logger export has a live production consumer; the dual public entry
surface (`createLog` vs the free `debug/info/warn/error`) is confirmed again as
load-bearing (the `loggerSelf` spy seam), with no surface reduction available.

## 5. Remaining open items (carried forward, none a defect)

1. **Model-handler port shape (forward-looking).** `IModelHandler` is a
   hand-maintained 42-member `Pick<ModelHandler<…>>`
   (`src/agent/types/IModelHandler.ts:27-77`). Internally the derivation is the
   correct anti-drift choice; a *public* SDK would want the port defined
   **intrinsically** (an `interface`) so it stops dragging the concrete class's
   five generic params (`M/U/T/C/Resp`, including the internal client and response
   types) into the exported surface. Not a defect and not mechanical — a
   manifest-design note, functionally inert today.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.**
   Located in two type hubs: `ProviderMessage.ts:4-8` (the `M` default union) and
   `ModelHandlerContracts.ts:4-7` (the `T`/`SdkToolCall` default). Load-bearing —
   the unions *are* the SDK message/tool-call shapes flowing through handlers
   (~20 files import `ProviderMessage`); not removable without a branded/opaque
   boundary. `scripts/validate-artifacts.mjs` already guards the built package
   against the leak. A manifest-design decision (whether `IModelHandler` can ever
   be a public export), not a cleanup.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a
   `UsageSink` port) behind Tier-1 `configureLogging` / `configureUsage` doors —
   specified in `docs/prds/2026-05-06-prd-logger-v2.md`, deliberately deferred
   behind singleton-retirement. §4a adds no new sub-item.
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door (blocked because a
   *dynamic* `import()` the ratchet counts would leave the leaf live for zero
   ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision. The public shape stays deliberately minimal (`cancel()`
   only, enforced: approval-requiring tools are withheld at launch,
   `packages/agent/src/index.ts:229-237`) until the approval channel has a stable
   contract.
6. **Result-taxonomy documentation.** The single largest surface clarification
   an external consumer needs. `AgentFlowResult` is a discriminated union on
   `category` (`toolUse | workflow`); the non-terminal `WAITING` state and
   `AgentFinalResult` are internal and never exported (the `runAgent` path uses
   `stopAfterCycle: true`, `index.ts:295`), so a public consumer cannot meet
   `WAITING`. The README (`packages/agent/README.md:41-52`) shows `result.outcome`
   but never explains the `category` discriminant. **A README omission, not a code
   leak** — the single highest-value documentation add on the surface.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side cleared previously (Apache-2.0 relicense, PocketFlow NOTICE, ToS scoping).
   The gate is now consumer-driven, not legal-driven.

## 6. Merges since the `-08-25` pass (49 commits touching audited areas)

None add a wrapper layer; the window is **100% `refactor` / `chore` / `fix`**,
dominated by single-owner collapses and dead-surface deletion — consistent with
the standing trend. Relevant to the audited areas:

- **Model / handlers** — `1d039b8` delete seven redundant surfaces across model
  handlers and auth (the `IModelHandler` 45→42 shrink); `c11bf8b` delete thirteen
  dead or redundant surfaces across shared, auth, model and utils.
- **Runtime / agent** — `a5fdd1b` collapse ten residual seams in the agent
  runtime; `fa228a0` collapse five cross-file seams in the agent flows, prompts
  and follow-up; `59896b8` collapse the tool-use round-state trio and the
  checkpoint alias; `a2bf904` one owner for the model-facing tool list and the
  tool contract; `9784610` finish the storage-transition cleanup.
- **Approval / settings** — `1ea59fa` one bypass-ancestry graph instead of three
  per-kind copies; `90dafda` delete the nested Core config tree and two
  hand-rolled setting readers.
- **Dependency** — `1dd16c4` bump `@anthropic-ai/claude-agent-sdk`; `0151274`
  bump llm-zoo to 1.31.0. (TeXRA consumes the Claude Agent SDK as a dependency;
  the external-CLI subagent strategies in §3 are the integration seam.)

## 7. Bottom line

Six consecutive passes (`-08-19` through `-08-27`) now find a green top-line
verdict, this one re-derived from four fresh independent area audits. The honest
answer remains "almost nothing to remove," and this pass is the cleanest of the
recent run: the two `-08-25 §8` removals stayed removed, the model-handler base
shrank a further 11 lines and its public port shed 3 members, and every one of
the 49 commits this window was a deduplication or collapse — zero new wrapper
layers. The only item any audit surfaced (§4a, a test-only redaction export) is
already tracked in the production-dead knip baseline and is a small refactor with
a coverage caveat, not a mechanical removal — recorded, not pushed. The remaining
structural work is unchanged and design-gated: the two open Tier-1 doors, the
injectable logger/usage ports, the manifest decision on `IModelHandler` (its
`M`/`T` leak and whether it can be a public export), and the one high-value
documentation add — the result-taxonomy story in the SDK README. Nothing found is
a defect; nothing warrants a speculative edit into the green tree absent a
maintainer request.
