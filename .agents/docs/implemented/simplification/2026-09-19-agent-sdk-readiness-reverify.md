# Agent-SDK readiness — re-verification pass (2026-09-19)

Status: implemented

> **Written 2026-09-19.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior filed pass
> ([`-09-17`](./2026-09-17-agent-sdk-readiness-reverify.md), the "thirteenth
> consecutive green", inspected at `3d5fbda`) and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **fourteenth consecutive green pass** (`-08-19` through `-09-19`).
> No `-09-18` record exists under [`implemented/simplification/`](./) — the
> routine did not file on that day — so `-09-17` is the immediately prior pass
> and the lineage has no gap in substance, only in calendar dates. Facts below
> are re-derived by direct inspection at `866af55` (#12830), the `main`/branch
> tip when this pass ran. Each carries a `file:line`, config path, or count.

> **Shallow-clone note.** The session began on a shallow clone whose floor
> (`415decf`, #12775) sat **inside** the `3d5fbda..HEAD` range, so a naive
> `git rev-list --count` reported a truncated **50 / 13** (total / in-area).
> The clone was deepened (`git fetch --deepen`) until `3d5fbda` was confirmed a
> true ancestor of HEAD and the count stabilized at **125 / 53**. This is the
> same shallow-count trap the `-09-17` and `-09-14` records were corrected for;
> the count below is the deepened one, not the shallow reading.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Fourteen
consecutive passes (`-08-19` → `-09-19`) reach the same top-line conclusion.
What is new this pass is not the verdict but:

- **Two convergent ratchet improvements landed on their own since `-09-17`,**
  both in the direction the standing open work names:
  - **`knip-baseline.json` shrank 180 → 170** (`config/ratchets/knip-baseline.json`,
    `len(findings) == 170`, verified by direct parse). Ten dead-ish exports
    found their consumer or were deleted; no entry was rewritten to hide a
    regrowth. The dead-code ratchet is the largest remaining frozen surface and
    it moved the right way.
  - **`shared-schemas-deep-import-baseline.json` is fully drained** — `surface`,
    `floors`, `forced`, `gratuitous` all `{}` (verified by parse). No deep
    import past `@shared/schemas` remains anywhere. (This was already drained at
    `-09-17`; re-confirmed here, not new this interval, but worth the standing
    record.)
- **Two small carried-nowhere findings newly surfaced by this pass's area
  audits** (§5), both verified, both **low-severity surface/convention items,
  neither a defect.** Per the routine's standing default — a scheduled firing
  carries no maintainer request — this pass is **recorded, not acted on**: no
  edit is landed by this document. The findings are filed in §5 for a future
  pass or an in-session maintainer request to pick up, exactly as the weeks of
  prior carried-forward survivors were.

`3d5fbda..866af55` is **125 commits, 53 of which touch the four audited areas**
(deepened clone; see the shallow-clone note). The range is dominated by the
Effect-4 round-trip campaign — closing Promise seams across the platform ports,
tools, storage, settings and agent-core callbacks (`f8a6f0b`, `3d0f5f0`,
`5abacaf`, `aaab6fc`, `dc40a4c`, `80a20d3`, `e2b5f47`, `de858f5`, `fbb0c4e`,
`53c35de`, `415decf`) — plus one dependency bump (`9bd6f99`) and one
subscription fix (`eca4b6f` "the Codex input budget is set in K tokens"). None
introduces an exported class, wrapper layer, or one-implementor interface in the
four audited areas; the structural conclusion is the §1–§4 end-state, resting on
the area audits and the ratchets that would reject such an addition, not a
per-commit review of all 125.

## 1. Method and scope

Four independent area audits — agent core + run loop, model handler +
`packages/llm`, logger, and the `@texra-ai/agent` package surface + subagent
boundaries — each re-derived the banned-pattern candidates (pass-through
wrappers, convenience barrels, one-impl interfaces, single-caller extractions,
re-export shims, silent degradation) and re-counted **production (non-test)
callers** for every candidate before it was kept or discarded, per the AGENTS.md
factory bar (a factory earns its place only with multiple callers, real logic,
class construction, or captured context).

Silent-degradation spot check: `grep` for empty `catch {}` blocks across
`src/agent`, `src/model`, `src/logger`, `packages/llm`, and `packages/agent`
(test-excluded) returns **zero** hits — an exhaustive result for that pattern.
The logger tree specifically has **zero** `catch`/`.catch` sites at all
(`src/logger/`), so its single emission point `writeLogEntry`
(`src/logger/logSink.ts:118`) propagates a throwing sink loudly, consistent with
the "silent degradation is a defect" rule.

## 2. Tracked structural facts — re-verified at `866af55`

| Item                                             | `-09-17` state        | This pass (`866af55`)                                                                                                                                            |
| ------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                             | deleted               | **still deleted.** `ls src/agent/node` → no such directory. Runs are the run-ledger Effect program (`src/shared/session/runLedger.ts`).                          |
| **`ModelHandler.ts` god-base / `IModelHandler`** | gone, no shim         | **still gone.** `grep "class ModelHandler\|IModelHandler" src/ packages/` (non-test) → zero production hits. Model stack is `ModelInvoker.ts` + `runtime/run/*`. |
| **`ModelInvoker.ts` LoC**                         | 1,326                 | **1,321** (`src/agent/runtime/ModelInvoker.ts`) — cohesive "call the Model, own retry"; minor shrink, no split.                                                  |
| **`redactSecrets`**                              | single-arg, clean     | **still clean.** `redactSecrets(text: string): string` (`src/logger/redaction.ts:58`), straight-line body.                                                       |
| **`turnText` leaf**                              | leaf, four importers  | **still a leaf.** `src/agent/runtime/run/turnText.ts:4`; no dup, no shim.                                                                                         |
| **SDK version**                                  | 0.41.0                | **0.41.0** (`packages/agent/package.json`).                                                                                                                       |
| **`effect` peer pin**                            | `4.0.0-rc.115`        | **`4.0.0-rc.115`** (`packages/agent/package.json`). No re-drift.                                                                                                  |
| **Deep-import width** (cli/desktop/ext/agent)    | 5 / 4 / 7 / 7 (= 23)  | **5 / 4 / 7 / 7 (= 23)** — unchanged this interval (`host-agent-import-baseline.json`, parsed). No baseline widened.                                             |
| **Tier-1 named doors**                           | 8/8 fronted           | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.                                                |
| **knip baseline**                                | 180                   | **170** — shrank 10; zero `packages/agent` entries.                                                                                                              |
| **shared-schemas deep imports**                  | drained               | **still drained** — `surface`/`floors`/`forced`/`gratuitous` all empty.                                                                                          |

Other ratchet sizes re-derived by direct parse (for the standing record):
`architecture-edges-baseline.json` **91 edges** (`logger` a pure leaf,
depending only on `shared` + `utils`); `host-agent-mock-baseline.json` **16
mock sites**; `effect-migration-baseline.json` **4 rows** (`platform()` 3
files, `ambient:asyncLocalStorage` 3 files, `new AbortController()` 2 files,
`catch:effect-importer` 2 files) — the migration is nearly zeroed;
`pure-tier-kernel-suites.json` **14 suites** (12 + 2); `store-public-surface-baseline.json`
**StreamLogStore 9 public methods**, `aggregateContracts` empty (RunSnapshotStore
already drained).

## 3. Loop ↔ ledger boundary — fold-based continuation (unchanged)

The verified property is the **continuation model**, unchanged from `-09-17`:
the two run programs (`runtime/loop/toolUse.ts`, `runtime/loop/reflection.ts`)
call `ledger.appendBatch(...)` and continue from the `RunState` the append
returns (`foldRunState` over committed rows), so live and resume are the same
function — no cursor, no graph, no intermediate flow engine. Every `appendBatch`
call site (ModelInvoker, `loop/toolUse`, `loop/toolUseDispatch`, `run/compaction`,
FollowUps) reaches the one `RunLedger` service (`src/agent/runtime/RunLedger.ts`);
no second writer. As `-09-14` established, this is a deliberately multi-owner
write side under one publisher, not a single-writer claim. Re-verified: the
CLAUDE.md "one publisher, loop-owned cards" rule holds on the loop's own path,
and no silent degradation in any of the four areas (§1).

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` (`src/agent/runtime/childRunLoop.ts:157`) +
`ChildRunPorts` (`:101`), driven by the single owner `startChildRunLoop`,
remain a shipped, multi-implementor SPI, not a design task. Four distinct
production construction sites (line numbers shifted slightly since `-09-17` by
intervening edits; the set is unchanged):

| Site                                                 | Constructor                                              |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:186` | `createNativeSubagentStrategy` (native subagent)        |
| `src/tools/delegation/workflowScriptStrategy.ts:156` | `createWorkflowScriptStrategy` (workflow-script child)  |
| `src/tools/bash.ts:231`                              | `createBackgroundBashStrategy` (background shell)       |
| `src/tools/agentCliShared.ts:609`                    | inline `ChildRunStrategy<TTurn>` (codex/claude CLI)     |

The host-agnostic driver (`runtime/childRunLoop.ts`) has exactly one delivery
site, so duplicate delivery is impossible by construction; the provider-coupled
strategies live in `src/tools/` behind the `ChildRunPorts` interface, which is
the natural subagent seam. Splitting further would produce single-caller helpers
the guardrail bans — no split recommended.

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear `Effect.fn` generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:492`), one
production caller running **inline in the extension host**
(`packages/extension/src/commands/agent/agentCreatorCommands.ts:299`). It stays
open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3).

## 5. Findings — surfaced this pass, recorded not acted on

Both are low-severity surface/convention items; neither is a defect, and neither
touches the run loop, the model stack, or any baseline in the widening
direction. Per the routine's standing default (scheduled firing, no maintainer
request) they are **recorded, not landed**.

1. **`@agent/index` host-barrel drift — 3 internal importers.** Both the core
   and runtime READMEs state that code inside `src/agent` imports the specific
   `@agent/<module>/<File>` path, never the host-facing barrel, so dependency
   edges stay explicit and the barrel does not become a convenience door
   (`src/agent/runtime/README.md:47-61`, `src/agent/core/README.md:46-54`). The
   `@agent/runtime` barrel discipline is intact — **zero** internal `src/agent`
   imports of `from '@agent/runtime'` (grep, non-test). But three internal files
   reach the `@agent/index` registry barrel instead of `@agent/index/agentRegistry`:
   - `src/agent/runtime/AgentLaunchContext.ts:7` — `{ isRemoteAgent, resolveAgentForLaunch }`
   - `src/agent/runtime/agentLoad.ts:4` — `{ getAgent }`
   - `src/agent/storage/runLifecycle.ts:11` — `{ isRemoteAgent }`

   All three symbols are declared directly in `@agent/index/agentRegistry`
   (`getAgent:227`, `isRemoteAgent:377`, `resolveAgentForLaunch:514`), so the fix
   is a mechanical re-point of the three import specifiers with no code change.
   Low value, low risk; deferred to a pass that already touches these files or an
   in-session request.

2. **`describeFollowUpFailure` — one symbol behind two public doors.** It is
   exported by the followUp barrel (`src/agent/followUp/index.ts:22`) **and**
   re-exported by the runtime barrel (`src/agent/runtime/index.ts:69`, from the
   deep path `@agent/followUp/ToolUseFollowUp`). Consumers split across both
   doors — e.g. `src/controllers/session/resumeRunPresentation.ts:2` reads it
   from `@agent/runtime` while CLI/tools callers read it from `@agent/followUp`.
   Collapsing to a single door (drop the runtime re-export, point its consumers
   at `@agent/followUp`) would shrink the surface by one entry. Deferred for the
   same reason; note it interacts with the deep-import baseline story, so any
   fix regenerates and re-validates the ratchets in the same change.

**Candidate examined and rejected (false positive).** The model-handler audit
flagged two single-symbol endpoint files — `src/model/openRouterEndpoint.ts`
(one const `OPENROUTER_BASE_URL`) and `src/model/providerEndpoint.ts` (one
function `normalizeProviderEndpoint`) — as fold candidates into
`src/agent/runtime/run/routeEndpoint.ts`. On inspection each has a consumer in
**both** layers — `src/model/glmRouting.ts` (the model layer) and
`run/routeEndpoint.ts` (the runtime layer). Folding into the runtime module
would force `src/model/glmRouting.ts` to import upward from `src/agent/runtime`,
a wrong-direction edge. Their current placement in `src/model` is the correct
shared-lower-layer SSOT; **no change.**

## 6. Carried-forward design notes (unchanged, none a defect)

- **There is no `platform().log` port, by design.** `src/platform/platform.ts:39-41`
  keeps diagnostics out of the platform abstraction; hosts install a sink
  directly via `setLogSink` (`src/logger/logSink.ts:108`). The logger is a
  single sink port with a single emission point and no host coupling — close to
  ideal for SDK extraction. The SDK-correct unlock (an injectable sink owner
  behind a Tier-1 door) remains designed for logging, unspecified for
  usage/telemetry, which stay process-global module singletons.
- **`IToolRegistry` single-impl is earned, not a smell:** its one implementation
  `MapToolRegistry` and the interface are both **exported from the published SDK**
  (`packages/agent/src/index.ts:58-63`) as the embedder tool-registry seam.
- **Provider fencing is clean:** `packages/agent/src/index.ts:26-33` sources
  `AgentFlowResult` from its own module (not the `@agent/runtime` barrel)
  specifically to keep the model-handler `.d.ts` graph out of the published
  surface, guarded by `scripts/validate-artifacts.mjs`'s `@anthropic-ai/sdk`
  check. Awareness-only: `src/agent/types/ServerTools.ts:11-19` still names both
  the Anthropic and OpenAI SDK **type** namespaces to build a normalized
  in-process server-tool result — inside the agent app, guarded by
  validate-artifacts, not on the published SDK surface.
- **`createChannelTrace` low-value tail:** 8 non-test call sites (was 7 at
  `-08-19`); still the low-value narrowing tail the passes have declined to
  chase, not a defect.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **publication** remains gated on the named-external-consumer hold.

## 7. Bottom line

Fourteen consecutive passes find a green top-line verdict. This pass's
substantive content is **two ratchet improvements landed by ordinary cleanup
(knip 180 → 170; shared-schemas confirmed fully drained) and two newly-surfaced
low-severity surface items, recorded not acted on** under the scheduled-firing
default: the `@agent/index` host-barrel drift (three internal importers that
should read `@agent/index/agentRegistry`) and the `describeFollowUpFailure`
double door across the followUp and runtime barrels. A third candidate — folding
the two single-symbol endpoint files — was examined and rejected as a
wrong-direction edge. All eight named doors stay fronted; the model stack is the
cohesive `ModelInvoker.ts` + `runtime/run/*` over the run ledger with no
`ModelHandler`/`IModelHandler` residue; the run loop's fold-based continuation
and the logger re-verify clean with no silent degradation; the subagent SPI is a
real four-implementor contract and `agentCreator` is the single, correctly-open
boundary. The standing open work is unchanged: **shrinking the frozen
deep-import lists** (unchanged 5/4/7/7 this interval) and the Tier-1
ratification — the manifest's enumeration half is done, its "what Tier-1 keeps
or seals" half is not.
