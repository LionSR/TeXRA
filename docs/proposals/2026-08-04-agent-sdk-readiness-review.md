# Agent-SDK readiness review — abstraction & surface audit (verification pass)

> **Status:** Verification / reconciliation, written 2026-08-04 at HEAD `5fc8cae`.
> This is **not** a new plan. It re-runs the "audit the core for unnecessary
> abstraction and unready surface" question against the current tree and
> reconciles the answer with the standing plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and its measured companions
> ([`2026-07-26-agent-sdk-foundation-gap.md`](./2026-07-26-agent-sdk-foundation-gap.md),
> [`2026-07-27-agent-npm-package-step3.md`](./2026-07-27-agent-npm-package-step3.md)).
> Every claim below carries a `file:line` or a config path and was checked at
> this HEAD.

## 0. Verdict

**The codebase is already well-aligned with an Agent-SDK shape. No structural
refactor is warranted, and no genuinely redundant abstraction was found to
remove.** This confirms the `-05-30 → -07-27` chain's standing conclusion ("no
structural refactoring is warranted"; the run surface is already SDK-shaped) and
finds nothing that reverses it.

The open work is **not** deleting abstraction. It is the two items the north-star
already names: (a) the **Tier-1 public manifest** so hosts stop deep-importing
`@agent/*` internals, and (b) shrinking the **bootstrap tax** — the setup steps
and ordered globals an embedder must perform before reaching `runAgent`. Section
5 lists the only fresh, concrete cleanup opportunities.

---

## 1. Scope audited

| Area          | Entry points inspected                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/runtime/{runAgent,executeAgent,SessionHandle,SessionEventHub,ModelCell,childRunLoop}.ts`, `src/agent/implementations/flows/` |
| Model handler | `src/agent/modelHandlers/ModelHandler.ts` (2008 LoC), `src/agent/types/IModelHandler.ts`                                                |
| Logger        | `src/agent/trace/{channelTrace,AgentTrace,noopTrace,helpers}.ts`                                                                        |
| Surface       | `packages/agent/src/index.ts`, `config/ratchets/host-agent-import-baseline.json`                                                        |
| Subagents     | `src/tools/delegation/`, `src/agent/{review,goal,roster}/`, `implementations/flows/agentCreator/`                                       |

---

## 2. Abstraction audit — nothing redundant to remove

Each layer flagged by a generic "collapse the wrappers" pass was checked against
the repo's own guardrails (single-owner rule, anti-shim, "factories need multiple
callers"). All are load-bearing:

- **`ModelHandler.ts` (2008 LoC) is a cohesive polymorphic base, not a
  god-class.** It already delegates its heavy machinery to collaborators
  (`mediaProcessor: MediaAttachmentProcessor` at `ModelHandler.ts:223`;
  `ResponseTextProcessing` at `:229-230`; `support/{ProxyConfigResolver,
UsageNormalizer,BackgroundPoller,AnthropicStreamHandler}`). The default-bodied
  concrete methods that look like pushdown bait are genuine multi-subclass hooks
  (`createMediaContent :1252`, `createResponseImpl :1213`, `extractServerToolData
:1707`, `backgroundModeSupported :220`) — each overridden by ≥2 providers. **No
  method is used by only one subclass.** This is correct polymorphism, not
  indirection.
- **`IModelHandler.ts` earns its keep.** It is a `Pick<ModelHandler, …>`
  (`IModelHandler.ts:41-85`) — structurally cannot drift from the class — and is
  consumed _as a narrowed port_ by code that must not see the full class
  (`runtime/ModelCell.ts`, `followUp/followUpMessages.ts`,
  `support/ProxyConfigResolver.ts`, `utils/UsageMonitor.ts`). It also carries one
  interface-only optional member the class does not (`createBatchedToolUseFollowUpMessages`,
  `:107-116`, feature-detected by `ToolUseDispatchNode`). Not redundant.
- **Runtime layering carries ownership/concurrency/lifecycle semantics, not
  pass-through.** `runAgent` (`runAgent.ts`, 213 LoC) owns executionId
  assignment, registration-vs-resume-lease, finalize-on-early-failure, and
  artifact-flush ordering — it is not a thin wrapper over `executeAgent` (the
  lower-level engine). `SessionHandle` is explicitly a composition record, "not a
  facade" (`SessionHandle.ts:1-30`). `SessionEventHub` is real filtered pub/sub
  with per-scope subscriber accounting. `ModelCell` is a concurrency-guarding
  cell. None are removable.
- **The logger surface is already minimal.** `AgentTrace` is the SSoT; every
  method reduces to `emit()`; TeXRA-specific helpers are _plain functions_ over
  the interface (`trace/helpers.ts`, `toolUseHelpers.ts`) — deliberately **no
  wrapper subclass**. `createChannelTrace` (`channelTrace.ts:30`) spreads
  `noopTrace` and overrides only the four log methods. This design already avoids
  the wrapper-class indirection a generic audit would flag. Nothing to remove.

**One structural observation (non-urgent, cohesion not removal):** within
`ModelHandler.ts`, the credential/wire-route cluster (`:470-720`, ~250 LoC) and
the compaction cluster (`:827-889` + `:1317-1497`, ~250 LoC) are the most
cohesive candidates for _future_ collaborator extraction (a `CredentialRouter`, a
`CompactionController`). Both are coupled to per-attempt mutable state that
`createResponse` mutates mid-turn, so extraction is a readability refactor with
real risk — **not** removal of unnecessary indirection, and against the repo's
single-owner/anti-churn posture it is a deliberate non-goal today.

---

## 3. Surface simplification — the Tier-1 fold-in targets

The intended public surface (`packages/agent/src/index.ts`, 300 LoC) is small and
clean: one entry `runAgent(input): AgentRun` (`:206`); a single-consumer pull
event stream (`AgentRunStream`, `:85-198`); `RunAgentInput`/`HostInteractions`/
`AgentRun` types; tool-authoring re-exports (`defineTool`, `ITool`, registries);
flow-result types. It is honest about what is **not** yet stable — approval
methods are withheld pending "a stable package-level contract" (`:42-47`),
`requestRetry` hard-denies (`:234-240`), child-run teardown is done by the package
itself because "no embedder ever runs" the hosts' shutdown handlers (`:282-285`).

Meanwhile the hosts still bypass the barrel with deep `@agent/*` imports, frozen
by `config/ratchets/host-agent-import-baseline.json`:

| Host      | Distinct `@agent/*` deep specifiers |
| --------- | ----------------------------------- |
| extension | 39                                  |
| cli       | 32                                  |
| desktop   | 25                                  |

Grouped by concern, the **highest cross-host overlap** (so the biggest
deep-import retirement per unit of Tier-1 work) is:

1. **Runtime control / lifecycle** — `runtime/{agentShutdown, detachSubagentsOnStop,
SessionHandle, HostInteractions, ExecutionHandle, runtimePresentationEvents,
terminalResultToast}` (≥2 hosts each; `runAgent` already exposed). _Highest priority._
2. **Resume / stream reattach** — `runtime/{resolveAndResumeStream,
resumeQueuedToolUse, SessionResumeRetrieval}`, `storage/detectWaitingStreams`.
3. **Trace** — `@agent/trace` (all 3; already partially re-exported).
4. **Storage** — `@agent/storage` (all 3).
5. **FollowUp** — `followUp/ToolUseFollowUp` (all 3).
6. **Config/definition** — `core/definition/AgentConfig` (all 3).

Host-specific tails are lower priority and single-host: cli's `export/*` cluster;
extension's model-handler / text-enhancement imports and its
`review/`+`agentCreator/`+`goal/` composition imports (see §4).

The invariant to hold while doing this (per CLAUDE.md): **never widen a
baseline.** Each promotion into the Tier-1 barrel should _shrink_ the matching
host list, not add a new export without a consumer.

---

## 4. Subagent boundaries

The subagent **dispatch** boundary is already cleanly drawn and host-agnostic:

```
delegate_agent / delegate_workflow        src/tools/delegation/DelegationTools.ts:104,212
      → executeSubagent()                  src/tools/delegation/subagentExecution.ts:71
      → createNativeSubagentStrategy()     src/tools/delegation/nativeSubagentStrategy.ts:124
      → startChildRunLoop()                src/agent/runtime/childRunLoop.ts  (one driver for
                                             every child-run type: agent-CLI codex/claude
                                             sessions, native subagents, workflow-script runs)
      teardown: detachSubagentsOnStop.ts
```

**Already independent-agent-like units (clean boundaries, promote as-is):**

- `src/tools/delegation/` — factored around the `ChildRunStrategy` abstraction
  driven by `childRunLoop`.
- `src/agent/review/` — `reviewDiff.ts` and `reviewIssues.ts` (both host-neutral,
  no `vscode`) already model a two-agent review→fix pipeline
  (`buildReviewInstruction`/`buildFixInstruction`).
- `implementations/flows/agentCreator/agentCreatorFlow.ts` — self-contained
  agent-authoring unit with its own `CreatorConfig`, `AgentCreatorUI` port, single
  entry `runAgentCreator()`.
- Agent-CLI adapters (`ClaudeAgentSessions`, `CodexThreads` in
  `src/tools/agentCliSessionStores.ts`) — external-subagent adapters already
  funneled through `childRunLoop`.

**Logical units that _could_ be promoted to first-class subagents but are still
runtime-coupled (why the extension still deep-imports them):** the two per-run
engines `implementations/flows/reflection/runReflectionFlow.ts` (340 LoC) and
`flows/tooluse/runToolUseFlow.ts` (725 LoC), and the autonomous `src/agent/goal/`
continuation loop. These reach deep into `runtime/*` (ModelFactory, SessionHandle,
RunContext, HostInteractions); isolating them behind the barrel is the same
Tier-1 work as §3, not a separate refactor.

---

## 5. Minor cleanup opportunities (the only actionable items)

These are small and independent of the strategic Tier-1 program:

1. **Tier-1 barrel, incrementally.** Promote the §3 cross-host runtime-control
   cluster into `packages/agent/src/index.ts` (re-export from the barrel), then
   migrate each host off the deep import and **shrink**
   `host-agent-import-baseline.json` accordingly. One cluster per PR keeps each
   change reviewable and each ratchet decrease verifiable.

   **Reconciliation (2026-08).** The first §3 increment (#10011) took an
   intermediate step instead of the `packages/agent/src/index.ts` promotion named
   above: it added a curated module-level barrel, `src/agent/runtime/index.ts`
   (imported as `@agent/runtime`), as the host boundary and left the package
   barrel untouched. Review comment `pullrequestreview-4918028384` flagged that
   scope change and asked for §5.1/§6 to record it if module-level barrels are the
   intended path — they are. Module-level barrels are the proving ground;
   promotion through `packages/agent/src/index.ts` is deferred until the
   host-boundary surface has proven stable. One cluster per PR still applies.
   `@agent/storage` was already a module-level barrel that exposed execution
   lifecycle/listing and resumability; #10531 folded the remaining host
   deep-imports (CLI's `executionLease` and `conversationFormat`) behind it,
   leaving `followUp` and `core/definition/AgentConfig` as the open clusters
   under #10024.

2. **Stabilize the withheld interaction contract.** The `HostInteractions`
   docstring (`index.ts:42-47`) and the hard-deny `requestRetry`
   (`index.ts:234-240`) are the concrete "not-yet-stable" markers. Deciding the
   approval/retry package contract unblocks exposing interactive tools and is the
   next surface decision, not a deletion.
3. **`ModelHandler.ts` cohesion (optional, deferred).** If and only if the
   credential-route or compaction clusters (§2) are touched for another reason,
   consider extracting the corresponding stateful collaborator then — do not open
   a standalone churn PR for it.

Nothing here is a defect; items 1–2 are the already-planned north-star work
surfaced with current line references, and item 3 is explicitly deferred.

---

## 6. Reconciliation

This pass reaches the same verdict as the standing chain and adds no new plan: the
run/config/event/result surface is SDK-shaped, the abstractions are load-bearing,
and the gap is packaging + bootstrap, not internal complexity. Readers acting on
this should work from the north-star plan of record; this document only refreshes
the evidence at HEAD `5fc8cae` and pins the current deep-import counts (39/32/25)
as the baseline to shrink.

**Reconciliation (2026-08).** #10011 began the §5.1 fold-in at the module-level
`@agent/runtime` barrel rather than `packages/agent/src/index.ts`, deferring
package promotion until the module-level barrels have proven the host-boundary
surface; see §5.1 and review `pullrequestreview-4918028384`. #10531 continued
the fold-in behind the pre-existing module-level `@agent/storage` barrel.
