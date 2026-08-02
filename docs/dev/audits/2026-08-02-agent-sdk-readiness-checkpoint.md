# Agent SDK Readiness — Verification Checkpoint (2026-08-02)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-08-01-agent-sdk-readiness-checkpoint.md`](./2026-08-01-agent-sdk-readiness-checkpoint.md)
(this pass reconciles against its §New-12…§New-18, its re-affirmed [TRACKED] set,
and the standing §9 ceiling rather than re-deriving them), the foundation-gap
analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md)
(§9 the real ceiling), the audit of record
[`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
the package-cut measurement
[`2026-07-27-agent-npm-package-step3.md`](../../proposals/2026-07-27-agent-npm-package-step3.md),
the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-08-01` checkpoint chain.

This pass inspected the tree afresh at HEAD `e263b01`
(`Merge pull request #9576 from LionSR/test/9531-production-delegation`;
`CHANGELOG.md` heading `[Unreleased]`; package version `0.40.0` — unchanged from
`-08-01`). The `-08-01` checkpoint pinned HEAD `6ab67ce`, which is not present in
this shallow checkout (`.git/shallow` exists), so a commit-count against it was not
computed; the reachable delta is small and test/fix-shaped — the most recent
history is `9b9c1e7` (await persisted parent recovery), `3969100` (persisted native
subagent resume test), `71c326f` (#9575 storage init once), `a87c110` (#9574 persist
retry lifecycle diagnostics), plus the #9576 production-delegation test merge at
HEAD. None of these are structural.

**Run context (honesty note).** This began as an **unattended scheduled run** with
no external adversarial review available, and the audit below was produced under
that constraint — read every finding as the output of a read-only pass. Per the
discipline every checkpoint since `-07-22` has held (the `-07-22`
applied-then-reverted `MapToolRegistry` and the `-07-30` authorized-but-reverted
`polishModel`/`createModelHandler` census are the worked examples), it recorded
**no code change**. The maintainer then came on-shift and authorized applying what
was cleanly applicable, which is what the discipline was waiting for — the
resulting four changes are listed in the
[Addendum](#addendum--what-landed-under-live-authorization) and are scoped to items
already on the standing record. Nothing in the "design-judgment" class was touched.
Method mirrored `-07-29`/`-07-30`/`-08-01`:
four parallel read-only deep-dives (agent core + flows + subagent boundaries; model
handlers; logging + trace + telemetry; runtime + public surface), each returning
file:line-cited findings, reconciled here against the standing record so
already-tracked items are not re-filed as fresh. The orchestrating pass then
re-verified every spine invariant and every retained finding by direct grep/read at
HEAD before recording it.

## Verdict — well-aligned; the four fresh deep-dives reconverge on the standing record with **zero new structural items and zero new latent defects**

**The codebase remains well-aligned and SDK-ready in shape; no new refactoring is
warranted from an unattended pass.** The core-shape conclusion every checkpoint
since `-06-26` has reconverged on holds unchanged. The distinguishing result of
this pass is a **negative** one worth recording in its own right: four independent
deep-dives, run without sight of the standing record, each re-derived a subset of
the _already-recorded_ items (§New-8, §New-9, §New-13, §New-14, §New-15, the §9
ceiling, and the accepted core inward→outward edges) and surfaced **nothing beyond
them**. In a chain this long, an independent re-audit that finds no new seam is
evidence the record is complete, not that the pass was shallow — the spine
invariants and both open defects were re-verified present at HEAD by direct grep.

The `packages/agent` public surface — `runAgent(input): AgentRun` where
`AgentRun extends AsyncIterable<AgentEvent>` + `{ result, interrupt() }`
(`packages/agent/src/index.ts:70-72,207`) — **is** the north-star
`run(agent, input) -> stream/result` shape, still implemented and still honest
about what it cannot yet do (approval-requiring tools throw `:215`; interactive
retry denies `:239`; the public `HostInteractions` is the minimal `cancel()` shape
`:49`).

## Spine invariants — re-verified at HEAD `e263b01` (direct grep this pass)

- **Host decoupling airtight.** `0` `vscode` imports across all declared VS Code-free
  zones (`src/agent`, `model`, `latex`, `tools`, `controllers`, `shared`,
  `replacement`, `eventBus`, `hosts`; test-kernel excluded) and `0` `packages/*`
  imports anywhere in `src/agent/runtime/`. (grep-confirmed)
- `src/agent/core/index.ts` **absent** — no barrel regression.
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`)
  intact; the base concrete `ModelHandler.ts` is **2,016 lines** — the derive-port-
  from-class ownership direction that §New-13 records as strategically inverted for
  external authorship, unchanged.
- `node/index.ts` flow engine carries **no** upstream-PocketFlow dead surface —
  `grep` for `BatchNode|ParallelBatch|setParams|\.params` over `node/` + `core/` +
  `implementations/` returns **0**.
- `MapToolRegistry` still the `Map | Record` shape exported through the package
  surface (the reverted `-07-22`/`-07-23` state, correctly not re-attempted).

## Reconciliation — this pass's four deep-dives vs. the standing record

Every retained finding maps to an existing entry; none is fresh.

| Deep-dive finding (this pass)                                                                                                                                                                                                                                                                           | Standing entry                            | State at HEAD                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `ModelHandler` base (~2,000 LoC) conflates provider adaptation with host/subscription/LaTeX policy; provider extension closed over the `PROVIDER_HANDLER_ROUTES` enum with no registration API; `IModelHandler` is a `Pick` of the base                                                                 | §New-13 + §9 item 3 + §New-8              | present, unchanged                                                               |
| `status` transition fans to three rails (trace `AgentEvent`, `updateStreamStatus` `SessionFact`, direct `statusListeners`)                                                                                                                                                                              | §New-9                                    | present; distinct consumers, no redundant sink — recorded, not deduped           |
| Non-terminal `WAITING` result leaks into the public result union; three-tier result stack (`RunToolUseFlowResult` → `AgentFlowResult` → `AgentFinalResult`); pick which is _the_ public result                                                                                                          | §9 + `-07-25` + foundation-gap §9         | present, unchanged                                                               |
| `ToolUseRoundShared` type re-export in `ToolUseRoundFlow.ts` mildly contradicts "import the defining file"                                                                                                                                                                                              | standing `-06-26`/`-07-25` re-export note | **fixed this pass** (addendum 3)                                                 |
| Two module-logging entry points (`logger.debug` vs `createChannelTrace(...).debug`, ~24 module-scope declarations); redaction path-stripping absent on the primary sink                                                                                                                                 | `createChannelTrace` census + §New-7      | present, unchanged                                                               |
| Product-domain fields ride generic types (`AgentFlowResult.compileFailures`, `updateCompileFailures`/`updateMissingOutputs`/`goalPaused` `AgentEvent` arms)                                                                                                                                             | §9 ceiling + `-07-25`                     | present; `AgentEvent` has the `domain` escape hatch, TeXRA arms not yet migrated |
| 96 frozen host→agent deep-import specifiers (cli 32 / desktop 25 / extension 39); no ratified Tier-1 manifest; npm publish disabled                                                                                                                                                                     | §New-12                                   | present; ratchets enforcing, publish gated `false &&`                            |
| Subagent seams (`ChildRunStrategy`/`startChildRunLoop`, `nativeSubagentStrategy`, lineage/detach, `ToolUseWaitNode`, helper-model one-shots, `agentCreator`) are an **exposure** problem, not a build problem; in-process parent-delivery handoff (#8093) is the load-bearing non-abstractable coupling | `-08-01` "Subagent boundaries" §1–7       | seams unchanged; re-affirmed                                                     |

## Open defects — found by the read-only pass, **fixed under live authorization**

Both were first recorded as "flagged, not touched" while the pass was unattended.
The maintainer then came on-shift and authorized applying whatever was cleanly
applicable, which supplied the out-of-pass reviewer the discipline requires. Both
are now fixed in the same change as this document; see
[Addendum](#addendum--what-landed-under-live-authorization).

- **§New-14 — silent-degradation `default: return` in `StreamSnapshotStore`.**
  Was at `src/transcript/StreamSnapshotStore.ts:468-469` (`case 'goalPaused':`
  folded into a bare `default:` with no `never` guard). Current behavior was
  correct; the hazard was that a newly subscribed run-fact type would silently
  no-op with no compile error. **Fixed** along the exact `-08-01` fix direction —
  explicit `goalPaused` no-op plus a selected-event callback type — and the guard
  is now load-bearing rather than decorative (negative test below).
- **§New-15 — divergent "a subscriber threw" log level.** `TraceEmitter.emit`
  logged at `debug` while the sibling `SessionEventHub.emit` logs the same
  condition at `warn`; `AppSignals.emit` deliberately re-throws. The `debug` level
  was quiet degradation per the guardrail. **Fixed** — the trace bus now logs at
  `warn`; the `AppSignals` re-throw is untouched as a different, documented
  contract.

## Task-prompt mapping (this run's assignment)

1. **Surface areas identified.** Agent core `src/agent/core/` + flows
   `src/agent/implementations/flows/`; runtime `src/agent/runtime/`; model handlers
   `src/agent/modelHandlers/` (+ `src/agent/types/IModelHandler.ts`); logger
   `src/logger/logUtils.ts` + trace `src/agent/trace/`; public surface
   `packages/agent/src/{index,schemas,node}.ts`.
2. **Abstractions to remove: essentially none.** No banned single-caller factory,
   pass-through wrapper, or redundant interface was found by any deep-dive. The one
   real hit was the cosmetic `ToolUseRoundShared` re-export shim, now deleted
   (addendum 3). The repo's
   anti-abstraction guardrails are visibly holding; the SDK gap is the _opposite_ of
   over-abstraction — it is boundary declaration and embeddability (foundation-gap
   §1: 16 imports / 14 setup steps for one turn vs. 1 / 0 in the reference SDKs),
   which the sealed `runAgent` facade already begins to close.
3. **Surface simplifications.** Applied: `packages/agent/README.md` (addendum 4).
   Still recorded, not applied — each needs a design ruling: ratify the `-07-25`
   de-facto Tier-1 list as an enforced manifest; add a `domain` escape hatch to lift
   TeXRA-specific fields out of `AgentEvent`/`AgentFlowResult`; decide the single
   public result type (`AgentFlowResult` vs `AgentFinalResult`) and keep `WAITING`
   behind the runtime boundary; define + ship a language-model port contract in
   `node.ts` (today `UNAVAILABLE_LANGUAGE_MODEL_PORT`); begin shrinking
   `host-agent-import-baseline.json` (96 entries) toward a seeded `@agent` barrel.
4. **Subagent split points:** already realized internally and enumerated by `-08-01`
   §1–7 — `ChildRunStrategy`/`startChildRunLoop` (reuse seam), `nativeSubagentStrategy`
   (run-a-TeXRA-agent-as-subagent adapter, why `executeAgent`'s 2-caller count is not
   an inline signal), the lineage/detach seam, the `ToolUseWaitNode`/`FlowTransition.
WAITING` core boundary, helper-model one-shots, and `agentCreator`. The blocker is
   exposure (extracting session/lease/persistence/parent-delivery behind public
   ports), not build; the in-process #8093 handoff is the load-bearing coupling a
   distributed SDK would need IPC/RPC for.
5. **Documented:** this checkpoint.

## Addendum — what landed under live authorization

Four changes, all previously on the record, all mechanical or guardrail-driven.
Nothing in the design-judgment class (§New-13 port-ownership inversion, §New-9
status-rail dedup, `ModelHandler` policy split, provider-registration API, Tier-1
manifest, `domain` migration, `WAITING` isolation, baseline shrinking) was touched
— those still need a design ruling, not a diff.

1. **§New-15 — trace-bus subscriber fault raised to `warn`**
   (`src/agent/trace/TraceEmitter.ts`). One level change plus a comment naming why
   the three buses differ. Closes the quiet-degradation gap.
2. **§New-14 — the run-fact switch made genuinely exhaustive**
   (`src/transcript/StreamSnapshotStore.ts`). The subscription list is now one
   frozen `SNAPSHOT_RUN_FACT_TYPES` tuple (`as const satisfies readonly
AgentEvent['type'][]`, the `RUN_FACT_EVENT_TYPES` idiom), the handled union is
   `Extract`ed from it, an `isSnapshotRunFact` guard narrows the hub's
   full-`SessionEvent` callback, `goalPaused` gets an explicit documented no-op,
   and the `default` arm is a `never` assertion. The runtime filter and the
   compile-time union can no longer drift, because the switch consumes the same
   tuple the subscription does.
   **Negative-tested, not assumed:** adding `'stage.start'` to the tuple without a
   handler fails compilation with `TS2322: Type 'StageStartEvent' is not
assignable to type 'never'`. Reverted after the check — the guard is load-bearing.
3. **Re-export shim deleted** (`src/agent/core/flows/ToolUseRoundFlow.ts`). The
   one-symbol `export { type ToolUseRoundShared }` is gone and its five importers
   (1 production — `ToolUseCycleNode` — plus 4 test-kernel files) now import the
   type from `toolUseRound/roundShared`, where it is defined. Most call sites
   already did. The file docstring claimed a "public entry point" role that the
   module no longer plays; corrected to match.
4. **`packages/agent/README.md` added.** The package had none. Documents the three
   entry points, the process-wide platform rule, and — deliberately — a
   **Current limits** section stating the refused approval-tools, always-denying
   interactive retry, absent resume, unavailable language-model port, and
   local-only agent loading. The usage example is compile-checked against the real
   types, not written from memory (the first draft used a `conversation.progress`
   field that does not exist; the correct arm is `stream.chunk` / `.text`).

**Verification:** `typecheck` clean across all 7 projects · `lint` clean ·
`format:check` clean · `check:dead-code-ratchet` 17 findings vs 17 baselined, no
new unused exports · `npm test` **8,442 passed**, 9 skipped, 825 files.

## Bottom line

Verification pass that turned into a small applied one when the maintainer came
on-shift. The area is well-aligned and its SDK gaps are fully enumerated in the
standing record; this pass adds independent confirmation at HEAD `e263b01`, found
no new structural item and no new defect, and closed the two open small ones
(§New-14, §New-15) plus two cleanups. The next move is unchanged and still needs a
live design ruling rather than another audit: ratify the Tier-1 manifest, then the
boundary-extraction sequencing already recorded.
