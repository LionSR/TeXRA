# Agent-SDK readiness — re-verification pass (2026-09-02)

> **Status:** Written 2026-09-02 against branch HEAD `646475d`
> (`ci(issue-tracker): raise the bar for post-merge follow-up issues`, #11750).
> The scheduled audit routine re-ran the standing question — "review the agent
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), written at
> pre-squash `51c04c6`). This pass re-derived the verdict from fresh, independent
> checks of the four audited areas (core, model handlers, logger, surface +
> subagents) rather than a diff of the prior entry, and reached the **same
> top-line verdict by an independent route — the alignment holds**. It also
> confirms both `-08-25 §8` landings persist at HEAD and that every measured
> motion since is readiness-positive. Unlike `-08-25`, this pass surfaced **no
> new removable surface** — the one dead `export` `-08-25 §4a` removed had no
> successor. Every claim below carries a `file:line`, config path, or count
> checked at `646475d`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present. The two behavior-preserving removals the `-08-25` follow-up
landed at maintainer request — the logger's dead `OutputChannelFactoryOptions`
`export` (§8a) and `SessionHandle.useHostInteractions`, the long-tracked PT-2
pass-through (§8b) — are **verified gone and stayed gone** at HEAD. This pass
found **nothing new to remove**: the logger and `SessionHandle` surfaces are now
clean, and the remaining open items are unchanged and design-gated, not defects.

This is the **sixth consecutive** green pass (`-08-19` through `-09-02`), and
the third of the six to be recorded rather than acted on — consistent with the
routine's default absent an explicit maintainer request (which this automated
firing does not carry; the two `-08-25` removals only landed because of a
follow-up ask).

## 1. Every `-08-25` tracked fact re-verifies at `646475d`

| Item                               | `-08-25` state (`51c04c6`)                               | `646475d` state                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **§8a** (dead logger `export`)     | landed: `OutputChannelFactoryOptions` de-exported        | **still gone.** `src/logger/logUtils.ts:48` is `interface OutputChannelFactoryOptions` (no `export`); only internal use at `:198`.          |
| **§8b / PT-2** (`SessionHandle`)   | landed: `useHostInteractions` removed                    | **still gone.** `grep -rn useHostInteractions src/ packages/` returns **zero** hits. `SessionHandle` re-exposes no per-concern method.      |
| **L-3** (dead redaction branch)    | closed; `redactSecrets` single-arg                       | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                  |
| **§7 Tier-1 doors**                | 4 of 8 landed (`export`/`review`/`templates`/`followUp`) | **present & stable.** `src/agent/{export,review,templates,followUp}/index.ts` all exist.                                                    |
| **M-3** `ModelHandler.ts` god-base | 2,043 LoC                                                | **2,030 LoC** (`wc -l`); **−13**, from the window's simplification sweeps. Genuinely shared behavior, no per-provider copy-paste.           |
| **Provider-type-leak floor**       | `M`/`T` leak all four provider SDKs                      | **unchanged.** `ProviderMessage.ts:4-8` still imports message types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`. |
| **Node flow engine**               | 159 LoC, `BaseNode`/`Flow` only                          | **158 LoC** (`src/agent/node/index.ts`); still exactly `BaseNode` + `Flow` (two `export`s). Matches CLAUDE.md.                              |
| **`IModelHandler` port shape**     | derived `Pick<ModelHandler<…>>`, anti-drift              | **unchanged.** `src/agent/types/IModelHandler.ts` still a derived `Pick`; forward-looking manifest note (§5.1), not a defect.               |
| **Version**                        | 0.40.5 (short of the v0.41 `runFact.` gate)              | **0.40.8** (`packages/agent/package.json`). Advanced three patches; still short of the v0.41 retirement gate. Retirement not yet due.       |

## 2. Frozen host deep-import width — shrank on CLI, held elsewhere

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-08-25` | `646475d` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **7**     |
| desktop             | 5        | **5**     |
| extension           | 9        | **9**     |
| agent (SDK package) | 7        | **7**     |

CLI shed one specifier (8→7) — the "shrink the frozen lists" work advancing, not
a widening. The set-based ratchet still forbids any new edge and fails on stale
headroom, so the lists can only shrink or hold; the "never widen a baseline"
invariant is structurally enforced. `agent`'s 7 remains at its realistic floor,
bounded by the provider-type-leak constraint (§5.2).

## 3. Subagent boundaries — unchanged, still mature

The subagent boundary remains a **shipped, multi-implementor SPI, not a design
task**, re-confirmed at HEAD:

- **Contract:** `ChildRunStrategy<TTurn>` + `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) — a deep module with a narrow turn-based
  interface, driven by five independent implementors (in-process TeXRA agent,
  workflow-script children, external Claude/Codex CLIs behind per-session
  registries, and background bash).
- **Recursion-closing seam:** the `AgentEngine` runtime slot filled at
  `src/tools/delegation/nativeSubagentStrategy.ts`, breaking the
  `registry → DelegationTools → executeAgent → registry` cycle.

The honest six-candidate mapping is unchanged. `reflection`/`tooluse` are the
`agentCategory` dispatch axis inside one run, not separate agents; `followUp`/
`goal` are substrate; `review` is a support library behind a tool-use YAML
agent; `roster` is the visibility-policy layer; `remote` is the auth+network
loader the SDK deliberately excludes (`includeRemote: false`). **Only
`agentCreator` remains the one genuine "logical agent not yet running as one"**
— a single linear `runAgentCreator`
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:440`, sole
production caller `agentCreatorCommands.ts:182` through `buildVSCodeUI()`),
running inline in the extension host. That boundary stays open **correctly**:
closing it is interactive-UI design work (the `AgentCreatorUI`/approval channel
the public `HostInteractions` deliberately lacks), not a mechanical move.

## 4. New this pass — no new removable surface

Unlike `-08-25 §4a`, this pass found **no new dead export or pass-through** on the
audited surfaces. The candidates checked and cleared:

- **Logger.** All public members of `src/logger/logUtils.ts` are live:
  `LogUtilsOptions` (`:30`) is the options type on `Log`'s four methods and the
  free log fns; `ChannelWriter`/`createChannelWriter` (`:157`/`:167`) and
  `disposeAgentChannel` (`:107`) are consumed by `src/agent/trace/channelTrace.ts`;
  the free `debug/info/warn/error` exports (`:222-225`) remain the `loggerSelf`
  test-spy seam (`-08-25 §5.3`, must stay). `redaction.ts`'s
  `PROVIDER_KEY_REDACTION_RULES` (`:28`) is **already tracked** in
  `config/ratchets/knip-baseline.json:1382` (`"name"` field) as production-dead /
  test-only (the
  desktop redaction parity test), not a new finding.
- **`SessionHandle`.** With PT-2 removed, a scan for one-line
  `return this.<owner>.…` pass-throughs returns **none** — the class's header
  contract ("re-exposes no per-concern methods") is now literally true with no
  exception.
- **SDK entry files.** `packages/agent/src/{index,schemas,node}.ts` exports are
  unchanged in shape from `-08-25`; no member became dead.

## 5. Remaining open items (carried forward, none a defect)

Unchanged from `-08-25 §5`; restated in brief:

1. **Model-handler port shape (forward-looking).** `IModelHandler` is a
   hand-maintained `Pick<ModelHandler<…>>` — the correct anti-drift choice
   internally, but a public SDK would want it defined intrinsically. A
   manifest-design note, not mechanical.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.**
   `U`/usage is already quarantined to `unknown` (`ModelCell.ts`); the fix
   template applies to `M`, but `T` is load-bearing (`call.raw` read at
   `ToolUseDispatchNode.ts` display-fallback sites) and must route through a
   handler method first. `scripts/validate-artifacts.mjs` guards the built
   package against the leak today.
3. **Logger + telemetry are process-global singletons with no public plug
   point.** The SDK-correct unlock is injectable owners behind Tier-1 doors. The
   **logging** half is designed: `docs/prds/2026-05-06-prd-logger-v2.md`
   specifies the `LogSink`/`Platform.log` port and `attachSink` bootstrap
   (a `configureLogging`-shaped door), deferred behind singleton-retirement. The
   **usage/telemetry** half (a `UsageSink` / `configureUsage` door) shares that
   architecture but has **no** referenced design doc yet — it is named across
   these readiness passes, not specified — so it remains the open sub-item here.
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (blocked on the interactive `AgentCreatorUI` design, §3),
   and a `core/state` door (a dynamic `import()` the ratchet counts would leave
   the leaf live for zero ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision. The public shape stays minimal (`cancel()` only) until the
   approval channel has a stable contract.
6. **Result-taxonomy documentation.** On the current public surface an external
   consumer meets exactly **one** result shape: `AgentRun.result` resolves to
   `AgentFlowResult` (discriminated `workflow | toolUse`;
   `packages/agent/src/index.ts:91`). The other two shapes are **internal, not
   exported**: `AgentFinalResult` (`src/agent/runtime/AgentFinalResult.ts:78`) is
   the post-flow envelope that adds `diffs`/normalized `cost`, consumed by
   `storage/resultMeta.ts`, and `WAITING` is the non-terminal state. The
   transforms are real, not delete candidates; the documentation gap is exactly
   this — spelling out that a consumer sees `AgentFlowResult`, why `WAITING`
   exists, and why `cost`/`diffs` live on the internal `AgentFinalResult` rather
   than on the exported result — the single largest "which result do I get?"
   clarification the surface needs, and a prerequisite before `AgentFinalResult`
   could ever join the public exports. #11683 (§6) flattened the _carriers_ of
   these results — indirection removal, not a shape change — which reduces the
   plumbing an eventual doc must describe.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side cleared earlier. The gate is consumer-driven, not legal-driven.

## 6. Merges since the `-08-25` pass — audited areas

The window is dominated by simplification and indirection removal, consistent
with the standing trend; none add a wrapper layer or widen a baseline. Relevant
to the audited areas:

- **Runtime result path** — `e919121` (#11683) _flatten runtime result carriers_
  — removed carrier indirection across `childRunLoop`, `sessionDescription`, and
  the reflection output nodes. Readiness-positive for §5.6.
- **Simplification sweeps** — `3dec1d5` (#11746), `83b6192` (#11737), `4505de2`
  (#11725) behavior-preserving simplification over repo-root `src/`, the source
  of the `ModelHandler.ts` −13 LoC.
- **Model transport hardening** — `867afe4` (#11718), `3fe1a17` (#11715) route
  Google streaming Interactions through the long-running transport / enforce its
  deadlines; `dc658c7` (#11745) bump `llm-zoo` to 1.32.0 and default to Claude
  Fable 5.1. No surface-shape change.
- **Follow-up ownership** — `6e3dda7` (#11710) preserve child-stream ownership
  boundaries; `2e93da1` (#11701) separate active and handle timestamps. Both
  tighten the substrate, neither adds surface.

## 7. Bottom line

Six consecutive passes (`-08-19` through `-09-02`) now find a green top-line
verdict, this one re-derived from fresh independent area checks. The honest
answer remains "almost nothing to remove," and this pass had **nothing** — the
two `-08-25` removals stayed removed, the model-handler base shrank another 13
lines, the CLI deep-import list shed a specifier, and the runtime result carriers
were flattened. Every measured motion this window was readiness-positive. The
remaining structural work is unchanged and design-gated: the two open Tier-1
doors, the injectable logger/usage ports, the manifest decision on
`IModelHandler` (its `M`/`T` leak and whether it can be a public export), and
result-taxonomy documentation. Nothing found is a defect; nothing warrants a
speculative edit into the green tree absent a maintainer request, which this
scheduled firing does not carry. The pass is recorded, not acted on.
