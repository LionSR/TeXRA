# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-03, all figures recomputed at HEAD
> `434b89d`. This is a _current-state_ re-measurement, not a new plan. It
> continues the daily checkpoint series — read alongside the immediately prior
> [`2026-08-02-agent-sdk-readiness-checkpoint.md`](./2026-08-02-agent-sdk-readiness-checkpoint.md) —
> and sits under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md)
> and the two measurements it depends on
> ([`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md),
> [`2026-07-27-agent-npm-package-step3.md`](../../proposals/2026-07-27-agent-npm-package-step3.md)).
> Its job is to confirm whether those conclusions still hold and flag what has
> since landed or remains open — nothing here overrides a maintainer ruling.
>
> **Amended same-day**, after tracing the fourth tracked delta (TD-2a) down to
> its actual runtime behavior at the maintainer's request for concrete
> follow-through: executing it would regress the SDK surface it was meant to
> improve. §7 retires it with the evidence; no code changes were made.

## Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The
four areas the task names — agent core, model handler, logger, and the package
surface — are already converged on the Claude-Agent-SDK shape by deliberate,
documented work, and the guardrails that hold them there (the
`config/ratchets/` baselines and the free-zone import fence) are _tightening_,
not slipping. This re-check adds evidence over the July docs: two of the four
tracked "finish-the-endgame" deltas have since landed cleanly, the host
boundary has measurably shrunk, and the fourth (TD-2a) turns out to already be
the correct shipped design rather than residue — retired in §7 rather than
executed, since executing it would have broken the npm package's tested
minimal-host contract for zero runtime benefit.

This matches the standing conclusion of the `-05-30 → -07-26` chain: the open
work is _deciding_ the product line and shipping the package, not untangling
abstractions. Re-deriving that here would duplicate ~23 prior docs.

## 1. Surface — `@texra-ai/agent` (`packages/agent/src/index.ts`)

The public run surface already mirrors the Anthropic `Query` pattern one-for-one:

- `runAgent(input: RunAgentInput): AgentRun` — a single entry, one import path.
- `AgentRun extends AsyncIterable<AgentEvent>` with `result: Promise<AgentFlowResult>`
  and `interrupt()`. One observation rail (the async iterator over the typed
  one-way `AgentEvent` fact stream) plus one terminal result — the SDK's
  "observe on the stream, block on a callback" principle, applied.
- `RunAgentInput` is five fields (`platform`, `agent`, `instruction`,
  `interactions`, optional `model`/`tools`). No 13-type config ceremony reaches
  the caller.

**Deliberate, documented gaps — not debt:**

- **No interactive approvals in the package.** `runAgent` throws for any
  approval-requiring tool, and `HostInteractions` at the package boundary is
  `cancel()` only (`packages/agent/src/index.ts`). This is the plan-of-record
  NS decision — approval methods join the contract when they have a stable
  package-level shape, not before. Correct as-is.
- **Definitions load only through the disk registry** (`loadAgents` /
  `resolveAgent`), not as injectable values. Also a live ruling (NS-4):
  document port-injection as the embedding path; add definitions-as-options
  only when a real external consumer asks. No change indicated.

The remaining blocker to publication is packaging/legal (the five §2 blockers of
the step-3 doc and the open-source-readiness audit's license/history gates), not
API shape.

## 2. Agent core (`src/agent/core`, `src/agent/runtime`, `src/agent/node`)

- **Launch is single-entry.** `runAgent` (`src/agent/runtime/runAgent.ts`, 212
  LoC) assigns the `executionId` and registers the run; `executeAgent` is the
  lower-level path for callers that already own the id (subagent dispatch,
  resume). The split is intentional and documented in
  `src/agent/runtime/README.md` — not a pass-through wrapper.
- **The flow engine is not indirection.** `src/agent/node/index.ts` (~250 LoC)
  is the sole local definition of `BaseNode`/`Node`/`Flow`; nodes create and run
  flows directly. There is no upstream-PocketFlow layer to collapse. (It _does_
  carry an unattended-attribution license obligation — see B2 of the
  open-source-readiness audit — but that is a NOTICE file, not a refactor.)
- **The session quartet is the seed surface** — `SessionHandle`,
  `session.events` (`SessionEventHub`), `session.interactions`
  (`HostInteractions`), `session.runs`/`status`. Frozen from outside by
  `host-agent-import-baseline` and the free-zone fence.

No unnecessary abstraction found to remove in core. The two-flow +
`agentCreator` decomposition and the runtime module set are the shape three
hosts converged on independently.

## 3. Model handler (`src/agent/modelHandlers`)

`abstract class ModelHandler<…>` (`ModelHandler.ts`, ~2,000 LoC) with one
concrete implementation per provider (`anthropic/`, `google/`, `openai/`,
`openrouter/`, `vscodelm/`). This is **genuine provider polymorphism** — real
shared logic (compaction, token-limit continuation, media/attachment handling,
usage accounting) behind a stable interface with five live subclasses — not a
redundant interface over a single implementation. Provider-specific concerns are
already extracted into cohesive files (`anthropicThinking.ts`,
`anthropicUsage.ts`, `anthropicContextManagement.ts`, …) rather than branched
inline. The base class is large but cohesive; splitting it would trade one
readable file for cross-file indirection with no caller benefit. **Keep as-is.**

## 4. Logger (`src/logger`, `src/agent/trace`)

Two tiers, cleanly separated, joined by thin adapters — no redundant layer:

- **Sink tier** — `src/logger/logUtils.ts`: channel management, redaction
  (`createRedactingSink`), and the functional `debug/info/warn/error` +
  `createChannelWriter` API. Host-agnostic.
- **Run tier** — `src/agent/trace/AgentTrace`: the run-scoped structured event
  stream (`AgentEvent`), where `log` is one arm among stages/streams/status.
- **Adapters** — `createChannelTrace` (a ~10-line log-only trace over
  `noopTrace` for module-level work outside a run) and `attachChannelSubscriber`
  (routes a trace's `log` events to a channel sink). Both are minimal bridges,
  not wrappers with their own policy.

Confirming the decoupling holds: `platform().log` has **0** call sites under
`src/agent` — agent logging flows through trace/channel, the intended
host-agnostic path. **No cleanup indicated.**

## 5. Subagent boundaries (task step 4) — already designed and shipped

The "logical units that could run as independent agents" already exist as
first-class runtime concepts; there is nothing to newly carve out:

- `executeAgent` + `childRunLoop` — subagent dispatch under an owned execution.
- `AgentRosterController` (`src/agent/roster/`) — the multi-agent roster.
- `detachSubagentsOnStop`, `resumeQueuedToolUse` — subagent lifecycle/resume.

The delegation _tools_ are exactly the closure that pulls in the heaviest import
graph (step-3 doc B1: 19 tools share one ~630-file closure), which is the real
packaging seam for a multi-agent SDK — a decision about where the product line
falls, already tracked, not a boundary to invent here.

## 6. What changed since the July plan (measured at `434b89d`)

The plan of record listed a four-item "finish-the-endgame" quartet (TD-2) and
warned the host boundary was eroding. Re-measured:

| Item                                                    | July status                      | HEAD `434b89d`                                                                                                 |
| ------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Host `@agent/*` deep-import width (ext/cli/desktop)     | 49 / 35 / 27, growing ~2.5/wk    | **39 / 32 / 25** — shrunk; ratchet-frozen at current                                                           |
| TD-2(b) phantom `RuntimeInteractionEventPayloads` arms  | 6 to relocate                    | **landed** — symbol absent repo-wide                                                                           |
| TD-2(c) `runFact.` string-prefix protocol (dated v0.41) | retire on schedule               | **landed** — absent under `src/agent`                                                                          |
| TD-2(a) `HostInteractions` request methods optional     | 7/7 `?`, 6 runtime-hard-required | **retired, not executed** — optionality is the tested minimal-host contract the npm package depends on; see §7 |
| TD-2(d) status dual-rail                                | complete atomically              | trace `status` arm still present (`trace/events.ts:153`); not independently confirmed here                     |

## 7. TD-2(a) re-investigated and retired (not executed — executing it would regress the SDK surface)

The prior section of this doc (and the north-star plan before it) treated
TD-2(a) — making the request methods on `HostInteractions` non-optional — as
blocked only on A2's fallback deletion landing. A2 has since landed in full
(verified at HEAD: `platform().toolEditApproval`, `RunContext
.toolEditApprovalHandler`, and every `create{Desktop,Cli}ToolEditApprovalPort`
factory are gone repo-wide). That unblocks TD-2(a) mechanically — but a deeper
trace of the runtime shows **executing it now would be a regression, not a
cleanup**, for reasons the July docs didn't have in front of them:

- **All 6 non-`openExternalInquiry` request methods already resolve through
  `SessionHostInteractions.enqueue()`** (`HostInteractions.ts:594–618`), whose
  `dispatch()` (`:686–715`) treats a missing method on the attached host
  exactly like a normal decline: `if (!result) { …; pending.settle(pending
.cancellationResult()); return; }` — no crash, no thrown error, a typed
  cancellation/deny result. `openExternalInquiry` is the deliberate exception,
  bypassing the queue to throw loud when unattached (comment at
  `HostInteractions.ts:525–528`).
- **This is a tested, documented contract, not an accident.** `warnParked`'s
  own message says it outright: _"A headless embedder must attach at least
  `{ cancel: () => {} }`, or blocking requests never settle."_
  `SessionInteractions.vitest.ts:606` (`'settles against the documented
minimal `{ cancel }` host'`) asserts exactly this: a bare `{ cancel: vi.fn()
}` host makes `requestPlanApproval` resolve `{ action: 'reject' }`, not
  throw. Every other request method degrades the same way.
- **The npm package depends on this contract to exist at all.**
  `packages/agent/src/index.ts:234–238` attaches `{ cancel, requestRetry }` —
  2 of 7 methods — and works today only because the other 5 gracefully
  decline. Making them required would force this file to add stub
  implementations for interactions it structurally can never reach (`runAgent`
  already throws upfront for any `requiresApproval: true` tool — verified this
  covers `UserQuestionTool`, `ExternalInquiryTool`, and `PlanTool` too, not
  only tool-edit/bash/proposal), producing dead ceremony code in exactly the
  package this whole effort exists to keep minimal.
- **The blast radius elsewhere is real and value-free.** A parallel sweep
  found `src/test-kernel/agent/progressTestUtils.ts`'s shared
  `createRecordingHost()` fixture missing 2 of 7 methods, plus **~25
  independent `src/test-kernel/**` files** that pass narrow 1–2-method inline
  `HostInteractions` literals by design (each exercises one interaction route
  in isolation). Required methods would force stub implementations into all
  of them for a signature change none of their tests exercise — pure test
  churn, the "add abstraction for hypothetical future requirements" pattern
  this codebase's own conventions rule out.

**Verdict: retire TD-2(a).** The "optional-with-graceful-decline" shape is not
residue from the dead legacy fallback A2 removed — it is the _replacement_
design, already shipped, tested, and load-bearing for the npm package's
minimal-host contract. Converting it to required would trade a working
progressive-capability host model for a rigid one, for no runtime benefit
`enqueue()` doesn't already provide. No code change made in this area.

## 8. Bottom line

Agent core, model handler, logger, and the package surface are aligned with
the Agent-SDK direction and actively converging — the boundary shrank, two
tracked deltas (b, c) landed cleanly, and the guardrails are holding. The
fourth tracked delta, TD-2(a), turns out on inspection to already be the
correct end state as shipped — not a residue to clean up — and this doc
retires it with evidence so it stops being re-proposed. There is no
unnecessary abstraction to remove and no subagent boundary to newly design in
any of the four audited areas; the only work still open belongs to the
packaging/legal track captured elsewhere.
