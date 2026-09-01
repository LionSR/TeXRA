---
created: 2026-09-01
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-09-01 at HEAD `a30ad5b` (v0.40.8,
> `chore: bump version to 0.40.8`, #11734) by the scheduled readiness routine.
> This is a _current-state_ re-measurement, not a new plan. It continues the
> checkpoint series — read alongside the most recent full pass
> [`../../proposals/2026-08-25-agent-sdk-readiness-reverify.md`](../../proposals/2026-08-25-agent-sdk-readiness-reverify.md)
> (written at `51c04c6`, whose §8 landed the last two shovel-ready removals) and
> the base audit
> [`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
> under the plan of record
> [`../../proposals/2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold at today's
> HEAD and to record what has moved. Every claim carries a `file:line`, config
> path, or grep'd count checked at `a30ad5b`. Nothing here overrides a
> maintainer ruling or reopens a retired proposal. **No production code was
> modified.**

## 0. Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The
four named areas — agent core, model handlers, logger/trace, and the
`@texra-ai/agent` package surface — remain converged on the Claude-Agent-SDK
shape. The pass-through wrappers, convenience barrels, and single-caller
factories this task hunts for are, once again, either absent or load-bearing
boundaries. This pass re-derived the verdict from a fresh independent
abstraction hunt over all four areas (grep'd caller counts, every `index.ts`
inspected) plus direct re-measurement of every tracked moving number; it
reached the standing green verdict by an independent route. **The two
shovel-ready removals recorded in the prior pass both landed and stay landed;
one stale docstring flagged back on 2026-08-10 is now fixed; nothing new is
removable.** The remaining work is unchanged and design-gated: the Tier-1
manifest, injectable logger/usage ports, the `IModelHandler` public-export
decision, the `agentCreator` boundary, and result-taxonomy docs.

## 1. Area confirmations (fresh evidence at `a30ad5b`)

- **Agent core.** Local flow engine `src/agent/node/index.ts` is **158 LoC**,
  still exactly `BaseNode` + `Flow` (no barrel, real classes) — matches
  CLAUDE.md. `runtime/index.ts` is the one curated re-export door (backed by the
  `host-agent-import` width ratchet); no `index.ts` barrels exist under
  `core/` or `implementations/` (verified via `find`), so there are no
  re-export shims. `ChildRunStrategy<TTurn>` is still the turn-based subagent SPI
  (`src/agent/runtime/childRunLoop.ts:171`). Single-caller helpers surveyed
  (`applyHelperModelPreference`, `withReasoningOverride`, `IToolUseSession`) each
  carry real policy/seam logic — not facades.
- **Model handlers.** `ModelHandler.ts` is **2030 LoC** (−13 since `-08-25`'s
  2043), continuing the genuinely-shared-behavior shrink with no per-provider
  copy-paste. `IModelHandler` is still a derived `Pick<ModelHandler, …>` view
  (`src/agent/types/IModelHandler.ts:33`) — drift-proof by construction, zero
  `implements`, not a redundant parallel port. Concrete handlers form a real
  inheritance tree (OpenAI-compatible ladder) with per-class quirks; no
  single-implementor abstract bases.
- **Logger / trace.** `redactSecrets` remains single-arg
  (`src/logger/redaction.ts:81`). `OutputChannelFactoryOptions` remains a
  **local** interface, not exported (`logUtils.ts:48`) — the `-08-25 §8a` removal
  held. The free `debug/info/warn/error` exports (`logUtils.ts:222-225`) stay —
  they are the sanctioned test-spy seam, not a duplication target. The
  `createChannelWriter` file docstring flagged stale in the
  [`2026-08-10 §4.1`](./2026-08-10-agent-sdk-readiness-checkpoint.md) checkpoint
  is **fixed**: it now correctly names `src/agent/trace/channelTrace.ts` (its
  only two production callers, `:38`/`:61`) instead of the vanished "protocol
  adapters."
- **Surface.** `@texra-ai/agent` still exposes exactly three curated entry
  points (`.`, `./schemas`, `./node`) with **zero `export *`** across all three
  files. `runAgent(input): AgentRun` still mirrors the Anthropic `Query` pattern
  one-for-one (`AgentRun extends AsyncIterable<AgentEvent>` + `result` /
  `interrupt`). `packages/agent/src/index.ts` is 322 lines of real
  `AgentRunStream` implementation plus documented curated re-exports; the
  deliberate `@agent/runtime/AgentFlowResult` deep import is still there for the
  documented provider-type-leak reason.

## 2. Baseline re-measurement (moving numbers at `a30ad5b`)

`config/ratchets/host-agent-import-baseline.json` — distinct `@agent/*`
deep-import specifiers past the barrel, per package:

| Package             | `-08-25` (`51c04c6`) | HEAD `a30ad5b` | Direction |
| ------------------- | -------------------- | -------------- | --------- |
| cli                 | 8                    | **7**          | ↓ shrank  |
| desktop             | 5                    | **5**          | held      |
| extension           | 9                    | **9**          | held      |
| agent (SDK package) | 7                    | **7** (floor)  | held      |

| Other ratchet                          | prior | HEAD `a30ad5b` | Direction |
| -------------------------------------- | ----- | -------------- | --------- |
| `architecture-edges`                   | 96    | **94**         | ↓ shrank  |

The "shrink, never widen" invariant is intact — `cli` shed one more specifier
and `architecture-edges` dropped two; nothing widened. `agent`'s 7 stays at its
realistic floor, bounded by the provider-type-leak constraint (§4.2). The
set-based ratchets still fail on both a new edge and stale headroom, so these
lists can only shrink or hold.

## 3. Prior shovel-ready items — reconciled at HEAD

| Prior item                                         | Status at `a30ad5b`                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-08-25 §4a/§8a` — de-export `OutputChannelFactoryOptions` | **Landed & held.** Now a local `interface` (`logUtils.ts:48`); `grep` finds no `export`.                            |
| `-08-25 §4b/§8b` — remove `SessionHandle.useHostInteractions` (PT-2) | **Landed & held.** `grep useHostInteractions src/ packages/` returns nothing; callers use `session.interactions.use(...)`. |
| `-08-10 §4.1` — stale `createChannelWriter` docstring | **Fixed.** Docstring names `channelTrace.ts`, no "protocol adapters."                                               |

The recent-commit window over the audited areas is dominated by
indirection-removal PRs (`refactor: behavior-preserving simplification sweep`
#11725, `flatten runtime result carriers` #11683, `privatize internal flow
types` #11706, `remove unused data layers` #11682, `remove unreachable cycle
response baseline` #11679). None add a wrapper layer or widen a baseline —
consistent with the standing trend.

## 4. Remaining open items (carried forward, none a defect)

1. **Tier-1 public manifest still does not exist.** The de-facto manifest is the
   union of the three entry files; declaring the manifest and sealing the SDK
   package's own 7-wide `@agent/*` seam behind it remains the strategic
   packaging work, not abstraction cleanup. Two of the eight Tier-1 doors stay
   open — fronting `agentCreatorFlow` (blocked on interactive `AgentCreatorUI`
   design, §5) and a `core/state` door (a dynamic `import()` the ratchet counts
   would leave the leaf live for zero gain).
2. **Provider-SDK type leak is the floor on `agent`'s 7 specifiers.** The
   `IModelHandler` `M`/`T` generics still surface provider message types;
   `scripts/validate-artifacts.mjs` guards the built package. Whether
   `IModelHandler` can ever be a public export is a manifest-design decision,
   not a mechanical move.
3. **Logger + usage are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a
   `UsageSink` port) behind Tier-1 `configureLogging` / `configureUsage` doors —
   specified in `docs/prds/2026-05-06-prd-logger-v2.md`, deliberately deferred
   behind singleton retirement. No new logger sub-item this pass.
4. **Result-taxonomy documentation.** An external consumer still meets three
   result shapes (`AgentFlowResult`, `AgentFinalResult`, the non-terminal
   `WAITING` state). Documenting _why_ each exists is the single largest
   "which result do I get?" clarification the surface needs.
5. **Publication** remains gated on the named-external-consumer hold; the legal
   side cleared earlier. The gate is consumer-driven, not legal-driven.

## 5. Subagent boundaries — still drawn, still mature

The subagent boundary is a shipped, multi-implementor SPI, not a design task:
`ChildRunStrategy<TTurn>` + `ChildRunPorts` (`childRunLoop.ts`) with the
`AgentEngine` runtime slot closing the recursion, driven by five independent
implementors (in-process TeXRA agent, workflow-script children, Claude/Codex
CLIs, background bash). The six-candidate mapping is unchanged: `reflection` /
`tooluse` are the `agentCategory` dispatch axis inside one run (not separate
agents), `followUp` / `goal` are substrate, `review` is a support library
behind a tool-use YAML agent, `roster` is visibility policy, `remote` is the
auth+network loader the SDK deliberately excludes. **`agentCreator` remains the
one genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`agentCreatorFlow.ts:440`, one production caller
`agentCreatorCommands.ts:182`) that runs inline through a VS Code UI port, not
`runAgent`/`ChildRunStrategy`. That boundary stays open **correctly**: closing
it is interactive-UI design work (the approval channel the public
`HostInteractions` deliberately lacks), not a mechanical move.

## 6. Bottom line

Six-plus consecutive passes now find a green top-line verdict, this one
re-derived from a fresh independent abstraction hunt plus direct re-measurement
at HEAD `a30ad5b`. Every measured motion since `-08-25` was readiness-positive:
`cli` deep-import width 8→7, `architecture-edges` 96→94, `ModelHandler.ts`
2043→2030, and the two prior removals plus the stale docstring all resolved and
held. There is **no unnecessary abstraction to remove** and **no subagent
boundary to newly design** — the `ChildRunStrategy` seams already are the
boundaries. The remaining work belongs to the packaging/design track (Tier-1
manifest, injectable logger/usage ports, the `IModelHandler` public-export
decision, `agentCreator`, result-taxonomy docs), not to abstraction cleanup.
Nothing found is a defect; nothing warrants a speculative edit into the green
tree absent a maintainer request.

---

_Method: one independent abstraction-hunt pass over agent core, model handlers,
logger/trace, and the package surface (grep'd caller counts, every `index.ts`
inspected, dead-export cross-check against `config/ratchets/knip-baseline.json`),
plus direct re-measurement of every tracked moving number against the ratchet
baselines at HEAD. Findings reconciled against the `-08-25` reverify pass. No
production code was modified._
