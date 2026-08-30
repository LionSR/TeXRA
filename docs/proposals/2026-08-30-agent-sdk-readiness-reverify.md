# Agent-SDK readiness — re-verification pass (2026-08-30)

> **Status:** Written 2026-08-30 against branch HEAD `b36051b`
> (`fix(hosts): preserve launch and walkthrough actions`, #11633), version
> `0.40.7`. The scheduled audit routine re-ran the standing question — "review the
> agent core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-08-25`](./2026-08-25-agent-sdk-readiness-reverify.md), which landed the two
> agreed removals §4a/§4b in its follow-up). Like the prior passes, this one
> re-derived the verdict from **four fresh, independent area audits** (core, model
> handlers, logger, surface + subagents) rather than a diff of the prior entry. It
> reaches the **same top-line verdict by an independent route — the alignment
> holds** — and confirms every measured motion since `-08-25` was
> readiness-positive. Every claim carries a `file:line`, config path, or count
> checked at `b36051b`.
>
> This is a **record-only pass.** No maintainer request accompanied this scheduled
> run, so — matching the pure-green passes `-08-19` through `-08-21` and unlike
> `-08-22 §8` / `-08-25 §8` — nothing was pushed into the green tree. The one soft
> new item (§4) is recorded shovel-ready, not executed.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are — with the two removals `-08-25` already landed now verified **still gone**,
and one low-confidence borderline in §4 — not present. This is the **sixth
consecutive green pass** (`-08-19` → `-08-30`), re-derived each time from
independent area audits rather than inherited.

The `-08-25` removals re-verify as durable at HEAD:

- **PT-2 (`SessionHandle.useHostInteractions`) stays removed.** `grep -rn
  useHostInteractions src/ packages/` returns **zero** hits; the class header's
  "re-exposes no per-concern methods" is still literally true.
- **`OutputChannelFactoryOptions` stays un-exported.** It is a local `interface`
  (`src/logger/logUtils.ts:48`), referenced only as the internal parameter
  annotation on `setOutputChannelFactory` (`:198`); `grep` for `export interface
  OutputChannelFactoryOptions` returns zero hits.

## 1. Every tracked fact re-verifies at `b36051b`

| Item                               | `-08-25` state (`51c04c6`)              | `b36051b` state                                                                                                                    |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **§4a/§4b removals (`-08-25`)**    | landed in follow-up                     | **still gone.** `useHostInteractions` 0 hits; `OutputChannelFactoryOptions` local (`logUtils.ts:48`), not exported.                |
| **L-3** (dead redaction branch)    | closed; `redactSecrets` single-arg      | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.         |
| **L-2** (process-global log sink)  | module-singleton, deliberate            | **unchanged.** `logUtils.ts` **263 LoC**; sole host seam `setOutputChannelFactory`, `console` fallback when absent.                |
| **§7 Tier-1 doors**                | 4 of 8 landed                           | **present & stable.** `src/agent/{export,review,templates,followUp}/index.ts` all exist.                                           |
| **M-3** `ModelHandler.ts` god-base | 2,043 LoC                               | **2,025 LoC** (`wc -l`); −18, continued dedup. Genuinely shared behavior, no per-provider copy-paste (README's "shared, not duplicated"). |
| **Provider-type-leak floor**       | `M`/`T` leak all four provider SDKs     | **unchanged.** Guarded by `packages/agent/scripts/validate-artifacts.mjs`; still the floor on the SDK package's 7 specifiers.       |
| **Node flow engine**              | 159 LoC, `BaseNode`/`Flow` only         | **158 LoC** (`src/agent/node/index.ts`); still exactly `export { BaseNode, Flow }` (`:158`). Matches CLAUDE.md.                     |
| **Version**                        | 0.40.5 (short of the v0.41 `runFact.` gate) | **0.40.7.** Advanced two patches; still short of the v0.41 retirement gate. Retirement not yet due.                             |

## 2. Frozen baselines — every measured dimension shrank or held

`config/ratchets/` at `b36051b`. The set-based ratchets forbid any new edge and
fail on stale headroom, so each list can only shrink or hold — the "never widen a
baseline" invariant is structurally enforced.

| Ratchet (`config/ratchets/`)                | Prior             | `b36051b`                          | Direction    |
| ------------------------------------------- | ----------------- | ---------------------------------- | ------------ |
| `host-agent-import` — cli                    | 8 (`-08-25`)      | **7**                              | ↓ shrank     |
| `host-agent-import` — desktop                | 5 (`-08-25`)      | **5**                              | held (floor) |
| `host-agent-import` — extension              | 9 (`-08-25`)      | **9**                              | held         |
| `host-agent-import` — agent (SDK pkg)        | 7 (`-08-25`)      | **7**                              | held (floor) |
| `host-agent-mock` sites                      | 38 (`-08-10`)     | **32**                             | ↓ shrank     |
| `architecture-edges`                         | 96 (`-08-10`)     | **94**                             | ↓ shrank     |
| `shared-schemas-deep-import` — forced        | 0 (`-08-10`)      | **0**                              | held         |
| `shared-schemas-deep-import` — gratuitous    | 36 (`-08-10`)     | **0** — barrel-rewrite tail drained | ↓ retired    |
| `shared-schemas-deep-import` — floors        | —                 | **1** (`@shared/schemas/log`)      | at floor     |

The two headline moves since the checkpoint chain: **cli shed one more `@agent/*`
specifier** (8→7), and the **`shared-schemas` gratuitous rewrite tail drained
fully to 0** — the mechanical `@shared/schemas` barrel-rewrite debt the `-08-10`
checkpoint flagged (§4.3 there, 36 specifiers) is now closed, leaving only the
single unavoidable `@shared/schemas/log` floor. Every motion this window was
readiness-positive; none added a wrapper layer or widened a baseline.

> Note on the `host-agent-import` metric: the baseline was regenerated/restructured
> in the ratchet-consolidation window (#11580, `25e0247`); the current per-package
> figures (cli 7 / desktop 5 / extension 9 / agent 7) are the set-of-distinct-
> specifiers count. The earlier checkpoint figures (34/31/25) counted a different
> unit and are not directly comparable; the `-08-22`→`-08-25`→`-08-30` figures
> (cli 8→8→7, desktop 6→5→5, extension 10→9→9) are apples-to-apples and trend down.

## 3. Subagent boundaries — still drawn, still mature

The subagent boundary is a **shipped, multi-implementor SPI, not a design task** —
re-confirmed by the core and surface audits at HEAD:

- **Contract:** `ChildRunStrategy<TTurn>` + `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) — a deep module with a narrow turn-based
  interface, upward channel just `notify(progress)` + `recordCost(usd)`.
- **Recursion-closing seam:** the `AgentEngine` runtime slot
  (`provideAgentEngine({ executeAgent, resumeToolUseFromResumeData })`), a
  load-time slot filled at `src/tools/delegation/nativeSubagentStrategy.ts`,
  breaking the `registry → DelegationTools → executeAgent → registry` cycle.
- **Five independent implementors** drive the one loop: in-process TeXRA agent,
  workflow-script children, external agent CLIs (Claude / Codex, behind
  per-session registries), and background bash.

The six-candidate mapping is unchanged: `reflection`/`tooluse` are the
`agentCategory` dispatch axis inside one run (`executeAgent.ts` branches on
`setting.agentCategory`), not separate agents; `followUp`/`goal` are substrate;
`review` is a support library behind a tool-use YAML agent (its `@agent/review`
door landed); `roster` is the visibility-policy layer; `remote` is an auth+network
loader the SDK deliberately excludes (`includeRemote: false`). **`agentCreator`
remains the one genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:437`,
single production caller) that runs inline through the `AgentCreatorUI` port, not
through `runAgent`/`ChildRunStrategy`. That boundary stays open **correctly** —
closing it is interactive-UI design work (the approval channel the public
`HostInteractions` deliberately lacks), not a mechanical move.

## 4. New this pass — one low-confidence borderline (record, do not execute)

**`runReflectionAgent` is a single-caller helper** (`src/agent/runtime/executeAgent.ts`,
def `:238`, sole caller `:480` — `grep` confirms exactly one call site). It exists
for visual symmetry with `launchToolUseRun`, which genuinely has two callers
(fresh + resume). Its body is usage-callback wiring + `WorkflowFlowResult` shaping
and could inline into the `agentCategory` branch at `:480`, which would satisfy the
repo's "single-caller extractions are banned" rule to the letter.

**Confidence: low. Not landed.** The symmetry with the two-caller `launchToolUseRun`
is a deliberate readability choice, and the result-shaping is non-trivial; inlining
trades a named seam for a fatter branch body. This is a judgment call for a future
focused refactor, not an asserted defect. It is the *only* soft candidate the four
audits surfaced across the entire agent-core / runtime / flows path this pass — the
model-handler and logger audits found **no** removable member (see §5.3).

## 5. Remaining open items (carried forward, none a defect)

1. **Model-handler port shape.** The public `IModelHandler` is a hand-maintained
   `Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts`). Internally the
   derivation is the correct anti-drift choice; a *public* SDK would want the port
   defined intrinsically. A manifest-design note, not mechanical.
2. **Provider-SDK type leak (`M`/`T`) is the floor on `agent`'s 7 specifiers.** The
   `U`/usage param is already quarantined to `unknown` (`ModelCell.ts`); `T` is
   load-bearing (`call.raw` read at the `ToolUseDispatchNode.ts` display-fallback
   sites) and must route through a handler method first. Note also that the shared
   `toolConversion.ts` carries **compile-time** (`import type`) coupling to the
   provider SDKs (e.g. `openai/resources/...` at `:25`) inherent to the `to*Tools`
   return shapes — no runtime-graph pollution, guarded by
   `validate-artifacts.mjs`, but a coupling to weigh for any split-package boundary.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   The SDK-correct unlock is injectable owners (a `Platform.log` port + a
   `UsageSink` port) behind Tier-1 `configureLogging` / `configureUsage` doors —
   specified in `docs/prds/2026-05-06-prd-logger-v2.md`, deliberately deferred
   behind singleton-retirement. The logger audit adds **no** new sub-item; the dual
   public entry surface (`createLog` vs the free `debug/info/warn/error`) is
   confirmed style-only with no reduction available (the free functions are the
   `loggerSelf` test-spy seam and are re-typed by extension ports).
4. **Two open Tier-1 doors remain** (four of eight landed): fronting
   `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door (blocked because a
   *dynamic* `import()` the ratchet counts would leave the leaf live for zero
   ratchet gain).
5. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, retired-as-shipped-design in the checkpoint chain; the public
   shape stays deliberately minimal (`cancel()` only) until the approval channel has
   a stable contract.
6. **Result-taxonomy documentation.** An external consumer meets three result
   shapes — `AgentFlowResult` (discriminated `workflow | toolUse`),
   `AgentFinalResult` (adds `diffs`/normalized `cost`), and the non-terminal
   `WAITING` state. The transforms are real (not delete candidates); documenting
   *why* `WAITING` exists and *why* `cost`/`diffs` land only on the final is the
   single largest "which result do I get?" clarification the surface needs.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side cleared earlier (Apache-2.0 relicense, PocketFlow NOTICE, ToS scoping). The
   gate is consumer-driven, not legal-driven.

## 6. Bottom line

Six consecutive passes (`-08-19` → `-08-30`) now find a green top-line verdict,
this one re-derived from four fresh independent area audits. The two `-08-25`
removals stayed removed (PT-2 gone, `OutputChannelFactoryOptions` un-exported); the
model-handler base kept shrinking (2,043 → 2,025 LoC); cli shed one more frozen
specifier (8 → 7); the `shared-schemas` gratuitous rewrite tail drained to 0; the
mock and architecture-edges baselines both fell (38 → 32, 96 → 94). Every measured
motion this window was readiness-positive. The only fresh item is one
low-confidence single-caller helper (§4), recorded shovel-ready and **not** pushed,
per the pure-green routine's default. The remaining structural work is unchanged
and design-gated: the two open Tier-1 doors, the injectable logger/usage ports, the
`IModelHandler` manifest decision, and result-taxonomy documentation. Nothing found
is a defect; nothing warrants a speculative edit into the green tree absent a
maintainer request.

---

_Method: four parallel evidence-gathering passes (agent core, model handlers,
logger, package surface + subagents), each required to back every claim with
`file:line` and grep'd caller counts and to state clean areas explicitly rather
than invent problems. Baselines re-measured directly from `config/ratchets/` at
HEAD `b36051b`. No production code was modified._
