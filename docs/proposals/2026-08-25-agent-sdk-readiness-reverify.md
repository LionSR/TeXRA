# Agent-SDK readiness — re-verification pass (2026-08-25)

> **Status:** Written 2026-08-25 against branch HEAD `51c04c6`
> (`docs: list remaining TeXRA papers on the public work page`, #11365). The
> scheduled audit routine re-ran the standing question — "review the agent core,
> model handler, logger, and surface for unnecessary abstraction and unready
> surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-22`](./2026-08-22-agent-sdk-readiness-reverify.md), written at pre-squash
> `d455149`, landed as `78759a4`). Like `-08-22`, this pass re-derived the verdict
> from **four fresh, independent area audits** (core, model handlers, logger,
> surface + subagents) rather than a diff of the prior entry. It reached the
> **same top-line verdict by an independent route — the alignment holds** — and
> surfaced **two behavior-preserving removals** verified at HEAD: one on the
> logger's public surface (a dead `export`) and one on `SessionHandle` (the
> long-tracked PT-2 pass-through, still present). Neither was landed this session:
> unlike `-08-22 §8`, there was **no maintainer request** to execute them, and
> the routine's default — matching the three pure-green passes before `-08-22` —
> is to record shovel-ready findings, not push into the green tree unbidden.
> Every claim below carries a `file:line`, config path, or count checked at
> `51c04c6`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are, with the two narrow exceptions in §4, not present. The exemplary deep
modules the prior passes named — `ModelCell`, `SessionEventHub`, `PersistedFlow`,
`AgentRunLifecycle`, `childRunLoop`, `ModelInvocationNode` — are all things you
would keep designing from scratch, and each re-verified as untouched-in-shape at
HEAD. What is new this pass is bounded and shovel-ready, not a reversal: a genuine
dead `export` on the logger surface (§4a) and independent re-confirmation that the
model-handler removals landed in `-08-22 §8` are gone and that PT-2 (§4b) is still
the one live pass-through in core. The `-08-22 §8` removals
(`createToolUseFollowUpMessages`, `createAssistantMessageForPrefillText`) are
**verified absent** from `ModelHandler.ts` and `IModelHandler.ts` at HEAD.

Two measured facts moved in the readiness-positive direction since `-08-22`: the
frozen host deep-import width **shrank** on two hosts (§2), and the model-handler
base class shrank by 26 lines with the `-08-22 §8` inlining (§1). Neither the SDK
package's 7-specifier floor nor the three entry files' exports changed.

## 1. Every `-08-22` tracked fact re-verifies at `51c04c6`

| Item                              | `-08-22` state (`d455149`)                          | `51c04c6` state                                                                                                                                     |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§4a/§4b removals**              | landed this session (§8)                             | **still gone.** `grep` for `createToolUseFollowUpMessages` / `createAssistantMessageForPrefillText` in `modelHandlers/` returns no base definition. |
| **L-3** (dead redaction branch)   | closed; `redactSecrets` single-arg                  | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                          |
| **L-2** (process-global log sink) | module-singleton, deliberate; no platform port      | **unchanged.** `logUtils.ts` 256 LoC; sole host seam is `setOutputChannelFactory` (2 callers), `console` fallback when absent.                      |
| **§7 Tier-1 doors**               | 4 of 8 landed (`export`/`review`/`templates` + rt.) | **present & stable.** `src/agent/{export,review,templates,followUp}/index.ts` all exist; `@agent/index` re-exports hold.                            |
| **M-3** `ModelHandler.ts` god-base | 2,069 LoC                                           | **2,043 LoC** (`wc -l`); −26, the `-08-22 §8` inlining. Genuinely shared behavior, no per-provider copy-paste (README's "shared, not duplicated").  |
| **Provider-type-leak floor**      | `M`/`T` leak all four provider SDKs                 | **unchanged.** `ProviderMessage.ts:4-8` still imports message types from `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@openrouter/sdk`.         |
| **Node flow engine**              | 159 LoC, `BaseNode`/`Flow` only                     | **159 LoC** (`src/agent/node/index.ts`); still exactly `BaseNode` + `Flow` (single `export` `:159`). Matches CLAUDE.md.                             |
| **Version**                       | 0.40.4 (short of the v0.41 `runFact.` gate)         | **0.40.5.** Advanced one patch; still short of the v0.41 retirement gate. Retirement not yet due.                                                   |

## 2. Frozen host deep-import width — shrank on two hosts, held on the floor

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package, past the `@agent` barrel):

| Package             | `-08-22` | `51c04c6` |
| ------------------- | -------- | --------- |
| cli                 | 8        | **8**     |
| desktop             | 6        | **5**     |
| extension           | 10       | **9**     |
| agent (SDK package) | 7        | **7**     |

Two hosts shed one specifier each (desktop 6→5, extension 10→9) — the
"shrink the frozen lists" work advancing, not a widening. The set-based ratchet
still forbids any new edge and fails on stale headroom, so the lists can only
shrink or hold; the "never widen a baseline" invariant is structurally enforced.
`agent`'s 7 remains at its realistic floor, bounded by the provider-type-leak
constraint (§5.4). This window's ~139 commits since `-08-22` (§6) are dominated
by indirection removal, deduplication, and discriminated-union tightening — none
add a wrapper layer or widen a baseline.

## 3. Subagent boundaries — still drawn, still mature (re-confirmed by two audits)

The subagent boundary is a **shipped, multi-implementor SPI, not a design task** —
re-confirmed independently by both the core and surface audits at HEAD:

- **Contract:** `ChildRunStrategy<TTurn>` + `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) — a deep module with a narrow turn-based
  interface (`launch` / `runTurn?` / `isTerminal` / `formatDelivery`; upward
  channel just `notify(progress)` + `recordCost(usd)`).
- **Recursion-closing seam:** the `AgentEngine` runtime slot —
  `provideAgentEngine({ executeAgent, resumeToolUseFromResumeData })`, a
  deliberate load-time slot (not a static import) filled at
  `src/tools/delegation/nativeSubagentStrategy.ts`, breaking the
  `registry → DelegationTools → executeAgent → registry` cycle.
- **Five independent implementors** drive the one loop: in-process TeXRA agent,
  workflow-script children, external agent CLIs (Claude / Codex, behind
  per-session — not process-singleton — registries), and background bash.

The honest six-candidate mapping is unchanged. **`reflection` and `tooluse` are the
`agentCategory` dispatch axis inside one run** (`executeAgent.ts` branches on
`setting.agentCategory`), not separate agents; **`followUp` and `goal` are
substrate**; **`review` is a support library behind a tool-use YAML agent** (its
`@agent/review` door landed); **`roster` is the which-agents-are-visible policy
layer**, not a run agent; **`remote` is an auth+network loader** the SDK
deliberately excludes (`includeRemote: false`). **Only `agentCreator` remains the
one genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts`,
single production caller `agentCreatorCommands.ts:184`) that runs inline in the
extension host through the `AgentCreatorUI` port, not through
`runAgent`/`ChildRunStrategy`, and is the deepest surviving host deep-import
specifier. That boundary stays open **correctly**, because closing it is
interactive-UI design work (the `AgentCreatorUI`/approval channel that the public
`HostInteractions` deliberately lacks), not a mechanical move.

## 4. New this pass — two verified, shovel-ready, behavior-preserving removals

Both are independently verified at HEAD and mechanical. **Neither was landed** —
there was no maintainer request this session (contrast `-08-22 §8`), and the
routine's default absent one is to record, not push into the green tree.

### 4a. Logger: `OutputChannelFactoryOptions` is an unnecessary `export`

`src/logger/logUtils.ts:49` declares `export interface OutputChannelFactoryOptions`,
but its **only reference anywhere** is its own use as a parameter annotation in the
same file (`setOutputChannelFactory(..., options: OutputChannelFactoryOptions = {})`,
`logUtils.ts:191`). Verified: `grep -rn OutputChannelFactoryOptions src/ packages/`
returns exactly those two lines — declaration and internal use — and it is **not**
in `config/ratchets/knip-baseline.json` (knip does not flag it because the internal
param use counts as a consumer). It is a public `export` with no external consumer,
which CLAUDE.md's "Exports are contracts" rule forbids.

- **Fix:** drop the `export` keyword (keep it a local `interface`), or inline
  `{ readonly trusted?: boolean }` into the `setOutputChannelFactory` signature.
- **Net:** −1 public export from the `@logger` surface; zero behavior change; a
  single-file, zero-blast-radius edit. This is the first removable member the
  logger surface has surfaced across these passes, and shrinks it before any
  freeze.

### 4b. Core: `SessionHandle.useHostInteractions` — the one live pass-through (PT-2)

`SessionHandle.useHostInteractions` (`src/agent/runtime/SessionHandle.ts:685-687`)
is a literal one-liner:

```ts
useHostInteractions(interactions: HostInteractions): () => void {
  return this.interactions.use(interactions);
}
```

It is the **sole violation** of the class's own documented contract: the header
(`SessionHandle.ts:4`) states it is "a **composition record**, not a facade: it
re-exposes no per-concern methods, so callers address each owner directly." Every
other owner is reached as `session.interactions.x(...)` / `session.executions.y(...)`;
this one method re-exposes `interactions.use`. **Six production callers**
(`packages/agent/src/index.ts` — so it is on the eventual SDK surface —
`packages/desktop/.../desktopAgentExecution.ts`, `packages/cli/.../runExecution.ts`,
`packages/cli/.../chatSessionController.ts`, `packages/cli/scripts/tui-harness.tsx`,
`packages/extension/.../ProgressViewProvider.ts`) plus ~30 test call sites, each a
mechanical retarget to `session.interactions.use(...)` (already public).

- **Net:** −1 method on `SessionHandle`; −1 entry from the eventual SDK surface;
  ~6 production + ~30 test call-site edits, all mechanical; no behavior change.
- **Status:** long-tracked as **PT-2** and marked "pre-authorized" in
  [`2026-08-03-ssot-consolidation-plan.md`](./2026-08-03-ssot-consolidation-plan.md)
  (C4), and carried in the `-07-09` / `-07-26` philosophy and foundation-gap
  proposals. Re-verified **still present and unchanged** at HEAD. It is the larger
  of the two by blast radius, so — like the three pure-green passes' posture on
  this exact item — it stays recorded, awaiting an explicit land decision.

## 5. Remaining open items (carried forward, none a defect)

1. **Model-handler port shape (forward-looking).** The public `IModelHandler` port
   is a hand-maintained 45-member `Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts`).
   Internally the derivation is the correct anti-drift choice; but a *public* SDK
   would want the port defined **intrinsically** rather than derived from the
   concrete base class. Not a defect and not mechanical — a manifest-design note.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers**
   (`-08-22 §4c`). The `U`/usage param is already quarantined to `unknown`
   (`ModelCell.ts`); the in-tree fix template applies to `M`, but `T` is
   load-bearing (`call.raw` read at five `ToolUseDispatchNode.ts` display-fallback
   sites) and must route through a handler method first. A manifest-design decision
   (whether `IModelHandler` can ever be a public export); `scripts/validate-artifacts.mjs`
   already guards the built package against the leak.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a
   `UsageSink` port) behind Tier-1 `configureLogging` / `configureUsage` doors —
   specified in `docs/prds/2026-05-06-prd-logger-v2.md`, deliberately deferred
   behind singleton-retirement. The logger audit adds no new sub-item beyond §4a;
   the dual public entry surface (`createLog` vs the free `debug/info/warn/error`
   exports) noted in `-08-22 §5.2` is confirmed a style-only duplication with **no**
   surface reduction available (the free functions must stay exported — they are the
   `loggerSelf` test-spy seam and are re-typed by extension ports), so it is not a
   simplification target.
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door (blocked because a
   *dynamic* `import()` the ratchet counts would leave the leaf live for zero
   ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, not a mechanical cleanup. The public shape stays deliberately
   minimal (`cancel()` only) until the approval channel has a stable contract.
6. **Result-taxonomy documentation.** An external consumer meets three result
   shapes — `AgentFlowResult` (discriminated `workflow | toolUse`),
   `AgentFinalResult` (adds `diffs`/normalized `cost`), and the non-terminal
   `WAITING` state. The transforms are real (not delete candidates); documenting
   *why* `WAITING` exists and *why* `cost`/`diffs` land only on the final is the
   single largest "which result do I get?" clarification the surface needs.
7. **Publication** remains gated on the named-external-consumer hold; the legal side
   cleared in the prior window (Apache-2.0 relicense, PocketFlow NOTICE, ToS
   scoping). The gate is now consumer-driven, not legal-driven.

## 6. Merges since the `-08-22` pass (`78759a4..51c04c6`, ~139 commits)

None add a wrapper layer; the window is dominated by indirection removal,
deduplication, and discriminated-union tightening — consistent with the standing
trend. Relevant to the audited areas:

- **Runtime consolidation** — `51a8b12` unify runtime resume and shutdown paths;
  `4b9536e` collapse the waiting-termination recovery ladder; `6492dd4` drop the
  single-consumer child-activation fan-out; `93cc177` drop the model-facing
  subscribe capability; the `session-deep-clean` series (`aa5ae20` one resume path
  via `resumeRun`, `ebd7c7e` one finalize tail, `9b424bb` one stream-to-execution
  index, `a69cf0d` one `ChildRunOutcome` union).
- **Ratchet / dead-code shrink** — `1111625` drop two ratchet baseline rows with
  no live site; `897ffd1` retire five export-only-for-tests symbols and one
  duplicated key; `a26652b` shrink the dead-code baseline instead of widening it.
- **Model / transcript dedup** — `47dc573` route Google onto the shared
  streaming-failure skeleton; `33c8f12` inline Google interactions media-round
  helper; `6512b8d` dedup StreamSnapshotStore overlay/write plumbing; `e072b02`
  consolidate model-list-refresh and secrets-key logic.
- **LaTeX / CLI** — `06c68a0` make `LaTeXdiffResult`/`DiffRunResult` discriminated
  unions (`07c029f` removes the checks the union made dead); `c46ecb7` derive
  `cliConfig` field-picking from one schema list.

## 7. Bottom line

Five consecutive passes (`-08-19` through `-08-25`) now find a green top-line
verdict, this one re-derived from four fresh independent area audits. The honest
answer remains "almost nothing to remove," and what there is was recorded, not
pushed: a genuine dead `export` on the logger surface (§4a) and the long-tracked
PT-2 pass-through on `SessionHandle` (§4b), both verified behavior-preserving and
mechanical at HEAD. The two `-08-22` removals stayed removed, the model-handler
base shrank accordingly, and the frozen deep-import lists shrank on two more hosts
— every measured motion this window was readiness-positive. The remaining
structural work is unchanged and design-gated: the two open Tier-1 doors, the
injectable logger/usage ports, the manifest decision on `IModelHandler` (its `M`/`T`
leak and whether it can be a public export), and result-taxonomy documentation.
Nothing found is a defect; nothing warrants a speculative edit into the green tree
absent a maintainer request. Consistent with the routine's cadence — and unlike
`-08-22 §8`, which landed at explicit request — this pass records §4a and §4b as
shovel-ready and leaves the land decision to the maintainer.
