# Lens: different layer, different abstraction; pass-through; decorators; context objects

Revisions: TeXRA `cae1afc30a` (paths under `packages/harness/src` unless stated), pi `c3d8ce4`, DeepSeek Harness (DSH) `f3803c96`. "Hop" means a function or module boundary on the path. "Adds" means the callee owns a decision or a fact the caller does not have; "forwards" means it passes its arguments through with nothing added.

## 1. Verdict

No project wins the whole lens. TeXRA has the fewest forwarding hops and no threaded context parameter: all three of its paths have at most one pure forwarder, and the Effect fiber context replaces what pi passes by hand 437 times. DSH has the cleanest layer graph (0 two-way dependencies among 369 workspace packages), but it gets it by moving retry, checkpointing and approval into decorators that a profile YAML mounts, so the loop's guarantees depend on deployment. pi-durable is tidy inside its package, but every hop carries `(task, runtime, context)`. pi's shipped CLI does not use pi-durable at all; it runs on a separate in-memory stack.

- **TeXRA: B.** Short paths with almost no forwarders, but its own layer order is crossed by 252 imported names, 117 of them in the agent/tools cycle; approval runs agent → tools → agent through a downcast; and a broad `Outcome` leaks to six callers.
- **pi: C+.** pi-durable is a B: few forwarders and a typed answer record, but an explicit context parameter everywhere and a 23-member `TaskRuntime`. coding-agent is a C: a 4,463-line `AgentSession`, mirrored queues, retry above the loop, and a 21-field config copied per run.
- **DSH: B.** An acyclic package graph, with interface packages beneath implementations. But decorators by event waterfall create unknown unknowns, and the SDK rebuilds the answer client-side.

## 2. Findings

### Path traces (hop counts)

| Path                            | TeXRA                                      | pi (durable / coding-agent)                                      | DSH (sdk-minimal)                          |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------ |
| 1 send + answer                 | 7 send hops, 1 forwarder; no answer handle | durable 5 + 3, 2 forwarders; coding-agent 5, no receipt          | 7, 1 forwarder; answer rebuilt client-side |
| 2 model call + retryable error  | 11, 1 forwarder                            | durable 7 phase hops; coding-agent retry lives in the host class | 6, 2 decorators the loop does not name     |
| 3 tool call + approval + record | 12, 2 forwarders, one layer sandwich       | durable 7; coding-agent 7 with 5 pass-through params             | 8, 1 forwarder, 3 waterfalls               |

**TeXRA path 1.**

1. `packages/cli/src/chat/chatSessionController.ts:908` (adds: message settlement).
2. `effect/sessionPrograms.ts:229` `request: handle.requests.request` is the same function reference, a zero-cost hop.
3. `controllers/session/SessionRequests.ts:427-449` (adds: media, `Outcome` mapping).
4. `agent/followUp/ToolUseFollowUp.ts:269` `submitFollowUp` (adds: one-shot check, rejection read, drain-on-stop, per-run lane, wake at :314).
5. `agent/followUp/Inbox.ts:122` `send` (opens the transaction).
6. `Inbox.ts:269` private `admit`, which **forwards** to `admission` and appends.
7. `Inbox.ts:282` `admission` (adds: claim hold, dedupe, `needsWake`).

The loop reads the message at `loop/toolUse.ts:151` (`claimFollowUps`) and `:322`. Answer: the host watches `view.changes` (`chatSessionController.ts:310`). The `followUp` outcome carries a status, not an answer reference. The SDK `Run` is now a pure view (`effect/runHandle.ts:19-54`), which closes the earlier SDK-side ownership hop.

**TeXRA path 2.**

1. `loop/toolUse.ts:376` `invoker.invoke`.
2. `ModelInvoker.ts:671`, which builds a 9-member `InvocationDriver` (`run/invocation.ts:85`).
3. `runInvocation` (`invocation.ts:353`) reads `nextAttempt` (`shared/session/inFlight.ts:203`).
4. `tryAttempt` (`:203`) under `ModelRetryGate.withRoutes`.
5. The `attemptOnce` driver (`ModelInvoker.ts:397`).
6. `prepareAttempt` (`:222`), which **forwards** to `bound.model.prepareTurn` and clears a closure variable.
7. `streamTurn` (`packages/llm/src/api/anthropicMessages.ts:659`).
8. The `retryable` verdict (`packages/llm/src/api/verdict.ts:268`).
9. On failure: `afterFailure` → `credentialRenewal` → `moveAfter` → `failedNext` (`invocation.ts:322,150,276`; `inFlight.ts:259`).
10. `driver.failed` → `failedRows` (`ModelInvoker.ts:687,609`).
11. `pauseBefore` (`invocation.ts:256`).

Every hop except 6 owns something. The retry decision is pulled down into `inFlight.ts` and the llm verdict. That is "pull complexity downwards" done right.

**TeXRA path 3.**

1. `dispatchPendingResponse` (`loop/toolUseDispatch.ts:304`).
2. `execute` (`:487`).
3. `callRequests` (`loop/toolGuard.ts:136`).
4. `preToolUse` → `hooksAt` (`loop/hooks.ts:386,170`), recorded at `toolUseDispatch.ts:532`.
5. `guardedToolCall` (`toolGuard.ts:115`), a single-caller combinator that **forwards**.
6. `guardRefusal` (`:39`).
7. `requestBashApproval` (`tools/approval/bashApproval.ts:79`).
8. That function calls `requireRun` (`agent/runtime/RunCall.ts:242`), then `sessionOf` (`RunCall.ts:225`), which casts the narrow `ToolRun` back to `BuiltinRun`. This hop **forwards** and undoes the narrowing.
9. `session.approvals.enqueue` (`runApprovalQueue.ts`).
10. `requests.open` → `session.requests.ask`.
11. The `tool.intent` commit (`toolUseDispatch.ts:546-552`).
12. The body under `ToolContext`, `ChildRuns`, `RunCall` and `step.services` (`:569-583`), then the `tool.result` commit.

The layer order on this path runs `agent/runtime/loop` → `tools/approval` → `agent/runtime` → `agent/runtime/loop`: a sandwich.

**pi.**

pi-durable path 1:

- Send: `Conversation.submit` (`packages/durable/src/harness/harness.ts:126`, forwards with the id bound) → `Submissions.submit` (`submissions.ts:68`, adds telemetry and resume) → `commitWith` → `admitSubmission` (`:198`) → `startRun` (`generation.ts:976`).
- Answer: `SubmissionHandle.wait` (`submissions.ts:162`, forwards) → `Submissions.wait` (`:109`, check and register on the line) → `#observe` (`:139`). The caller gets a typed settled record.

pi-durable path 2: `phases.request` (`generation.ts:240`) → `streamResponse` (`:619`) → pi-ai → `classify` (`:687`), using `isRetryableAssistantError` at `:753` → checkpoint `phase: "retry"` → scheduler sleep → `phases.retry` (`:277`) → `prepare` (`:162`).

pi-durable path 3: `ToolTask.phases.call` (`tool.ts:148`). It validates, lets `beforeTool` hooks block or rewrite (`:163-174`), validates again, and commits intent with the final arguments (`:186-191`). Then `run` builds a 20-member `ToolExecutionApi` (`:401-470`) → `settle` (`:791`) → `appendToolResult` (`:1052`). There is no built-in approval.

coding-agent, the shipped host, depends on `pi-agent-core`, not `pi-durable` (`packages/coding-agent/package.json`):

- Path 1: `interactive-mode.ts:1280` → `AgentSession.prompt` (`core/agent-session.ts:2097`) → `_queueSteer` (`:2307`), which also writes the mirror `_steeringMessages` (`:395`) → `Agent.steer` (`packages/agent/src/agent.ts:308`, forwards) → queue → pulled by `getSteeringMessages` (`agent.ts:506`).
- Path 2: retry is decided in the host class (`agent-session.ts:1993`, `_prepareRetry` at `:3826`, an in-memory counter at `:413`), above the loop.
- Path 3: `executeToolCalls` → `Sequential`/`Parallel` → `prepareToolCall` → `executePreparedToolCall` → `finalizeExecutedToolCall` (`agent-loop.ts:518,540,718,831,869`). Five parameters (`currentContext, assistantMessage, config, signal, emit`) pass through four levels. The result is persisted afterwards by an event observer (`agent-session.ts:1165`).

**DSH.**

- Path 1: `run` (`packages/sdk/client/src/api.ts:211`) → JSON-RPC → `handleRequest` (`sdk/server/src/server.ts:426`) → `prompt` (`:253`) → `agent.followup` (`core/agent-loop/src/agent.ts:179`, forwards) → `send` (`:170`) → `inbox.splice` and wake. The answer is `finalResponse(events)` after idle (`api.ts:235-257`).
- Path 2: `loopCtx.llm.stream` (`agent.ts:489`), wrapped by the `llm/stream` checkpoint decorator (`session/session-checkpoint-policy/src/index.ts:51`). On error, `dispatch.waterfall('agent/request-error')` (`agent.ts:548`) runs the `llm-retry` listener (`llm/llm-retry/src/index.ts:161`), which exists only if the profile mounts it (`bundle/sdk-minimal/cordis.patch.yml:133`).
- Path 3: `loopCtx.tools.execute` (`agent.ts:584`) → `ToolsService.execute` (`core/tools/src/index.ts:375`, forwards to the selected executor) → `pipeline.prepare`, which snapshots, runs the `tools/pre-execute` waterfall, asks, and checks guards (`pipeline.ts:196-235`) → the `tools/execute` waterfall (`:299`, where the checkpoint decorator lives) → `tools/post-execute` (`:487`) → `tool/result` appended (`agent.ts:377`).

### TeXRA

- **+ Pass-through eliminated by the context.** The run's services are not threaded through calls. `runToolUse` yields them (`toolUse.ts:145-147`) where pi threads `context: Context` through 437 parameter declarations in 32 files (`grep -c "context: Context"` over `packages/durable/src`).
- **+ Deep retry module.** One loop, reused by compaction (`run/modelCall.ts:123`). Its decision is a pure function of rows (`inFlight.ts:203,259`). pi-coding-agent decides retry in the host, and DSH decides it in an optional decorator.
- **- Layer sandwich and downcast (different layer, different abstraction; information leakage).**
  - `ToolRun` is declared with only `runId` (`agent/core/tools/ToolTypes.ts:186`), then widened from above by `declare module` with 8 fields (`RunCall.ts:151-162`).
  - Built-ins cast it back to reach the session (`RunCall.ts:225`, used by `bashApproval.ts:88` and `toolEditApproval.ts`).
  - The narrow type hides nothing, and its sole approval caller is the loop (`toolGuard.ts:102`).
  - The cost shows in the ratchet: `tools->agent` lists 90 names, `RunCall` alone 10, and `agent->tools` 27, including `approval/bashApproval`. Method: `json.load` over `config/ratchets/harness-layer-names-baseline.json`, grouped by module.
- **- Context bags.**
  - `runToolUse` requires 28 services: `TurnServices` (`toolUse.ts:88-95`), which includes the 20 `ProcessServices` (`platform/processRuntime.ts:101-121`), plus `ModelInvoker` and `Scope`.
  - A plugin tool is allowed 24 (`CallServices`, `agent/runtime/ToolServices.ts:31`), including `Secrets` and `GlobalDatabase`.
  - `AgentRunShape` has 19 members (`run/AgentRun.ts:88-125`) and `SessionHandle` 12 (`SessionHandle.ts:329`).
  - `Context.pick` is used at 3 sites (`tools/liveTools.ts:153`, `SessionRequests.ts:66,68`). Whole-context `Effect.context<T>()` is used at 5.
  - One of the 5 breaks the root `AGENTS.md` rule. `childRunLoop.ts:590` captures the tool-call fiber's whole context and re-provides it inside the child's turn finish (`:533,552`), where it shadows the child's own provisions. The hazard is inferred: I did not trace which services `buildTurnResult` reads.
- **- Initialization cycle hidden by thunks.** The cycle is `session: () => session` (`controllers/session/sessionLayer.ts:186,202`). The session is read lazily at 37 sites (`grep "\.session\(\)"`), and `registryOf` downcasts `RunsShape` at 13 sites in 10 files (`runRegistry.ts:816`).
- **- Overexposed result union.** `Session.request` returns one `Outcome` (`effect/sessions.ts:255`), so callers narrow it and each one invents a different answer for the impossible case:
  - `not_resumable` (`chatSessionController.ts:924`);
  - a silent return (`packages/cli/src/chat/tui/forms/TasksForm.tsx:373`);
  - `'sent'` (`packages/cli/src/commands/tasks.ts:268`);
  - `void` (`packages/texra/src/controllers/session/hostRunActions.ts:481`);
  - a throw (`packages/desktop/src/renderer/projectWorkbench.ts:130`).
- **- Pass-through variable.** `streamedTail` (`ModelInvoker.ts:214`) is written by `failAttempt` and `prepareAttempt` (`:217,225`) and read in the `failed` callback (`:694`). It exists because `AttemptFailure` (`invocation.ts:59`) cannot carry the partial text: a closure channel across the retry loop.

### pi

- **+ Typed answer.** A `Submission` relates input to answer (`submissions.ts:109-122`), the thing TeXRA's `followUp` outcome lacks.
- **+ Package DAG.** telemetry ← ai ← agent ← coding-agent, and ai/chord/codemode ← durable (each `package.json`). Inside durable, the 3 two-way directory pairs all run through the root entry. The only non-entry upward imports are 2 type imports (`types.ts:13`, `entries.ts:2`).
- **- Pass-through variable everywhere.** The `Context` of `packages/chord/src/context/index.ts:11`, plus `runtime: Runtime` in 15 generation and 13 tool helpers.
- **- Flow engine with a context bag.** Phases (`generation.ts:144-335`, `tool.ts:135-237`) over a 23-member `TaskRuntime` (`types.ts:261-350`).
- **- Shallow host god class.** `AgentSession` is 4,463 lines. It mirrors the agent's queues (`:395` vs `agent.ts:197`) and copies 21 public mutable fields into a per-run config (`agent.ts:476-516`). Hooks are public fields (`agent.ts:207`, set at `agent-session.ts:653`). That is overexposure and temporal decomposition.

### DSH

- **+ Dependency inversion by interface package.** `dsh-agent` (1,824 lines) sits below both `dsh-agent-loop` and `dsh-tools`. Tools see an `Agent` interface, never the loop. Across 369 packages there are 0 two-way pairs (a script over every `package.json`, `dependencies` plus `peerDependencies`).
- **+ Arguments frozen before decision** (`pipeline.ts:151-156`). This defines rewrite-after-approval out of existence.
- **- Decorators decide correctness (unknown unknowns).** Checkpoint-before-dispatch and retry are waterfall listeners of 3 to 10 lines (`session-checkpoint-policy/src/index.ts:43-73`, `llm-retry/src/index.ts:161`). A profile without them still runs.
- **- An acyclic graph is not a layered one.** Core `dsh-tools` depends on the interaction package `dsh-user-approval`. The DAG holds, but "core" is not below "interaction".

## 3. What TeXRA should do (ranked by complexity removed)

1. **Remove the `SessionHandle` initialization cycle and `registryOf` downcasts.**
   - Red flags: hidden temporal coupling, a context bag, and information leakage through casts.
   - Change: the session Layer provides each owner directly. This deletes the lazy `session()` reads and the 13 `registryOf` casts (`sessionLayer.ts`, `runRegistry.ts`, `SessionRequests.ts`, `resumeRun.ts`, `loop/runProgram.ts` and others).
   - Net: the PRD's −300 to −350. My count of 37 thunk reads plus 13 casts is consistent with it.
   - Peer evidence: pi hands handles a private 7-member `ConversationHost` with no casts (`harness.ts:96-104`).
   - **ALREADY QUEUED (row 9, C1-C5).**
2. **Move the approval ask into the loop layer that alone calls it.**
   - Red flags: different layer, same abstraction; a forwarding narrow/widen pair.
   - Change: move `requestBashApproval` and `buildBashApprovalRejectedResult` from `tools/approval/bashApproval.ts` into `agent/runtime/loop/toolGuard.ts`, or next to `runApprovalQueue.ts`. They then take the `AgentRun` the loop holds. Delete the `requireRun`/`sessionOf` round trip for this caller.
   - Net: about −15 lines (the bashApproval import, context and cast lines at the #14413 head, by reading its diff), −2 `agent->tools` names and −1 to −2 `tools->agent` names.
   - Peer evidence: the DSH pipeline asks through a service it depends on and never reaches back into the loop (`pipeline.ts:198-208`).
   - **NEW.** Row 5 (#14413) moves the policy into `toolGuard.ts` but keeps the ask in `tools/`, still calling `requireRun` and `sessionOf`. The wider 117-name agent/tools cycle is **ALREADY QUEUED (row 12, built-in tools out)**.
3. **Type `Session.request` by kind.**
   - Red flags: overexposure, and silent degradation in callers.
   - Change: `request<K>(r): Effect<OutcomeOf<K>, RequestError>` in `effect/sessions.ts` and `shared/session/runtimeRequest.ts`. This deletes the five divergent impossible-case branches listed above.
   - Net: about −10 (PRD estimate), plus consistency.
   - Peer evidence: the pi `Submission.wait` return type is specific (`submissions.ts:109`).
   - **ALREADY QUEUED** in the PRD's 2026-10-28 design-line table (`session.request` ①), but absent from rows 0-13. Fold it into row 7.
4. **Let a failed attempt carry its own partial text.**
   - Red flags: pass-through variable, temporal coupling.
   - Change: add `partialText` to `AttemptFailure` (`invocation.ts:59`) or to the attempt's failure, and delete `streamedTail`, `failAttempt`'s side effect and the `prepareAttempt` wrapper (`ModelInvoker.ts:214-226`). While there, take `RouteRetries` from context for `call` instead of capturing it at `:187` and re-providing it at `:810`, which is two routes to one dependency.
   - Net: about −10, counted from the 10 referencing lines.
   - Peer evidence: in pi-durable, `classify` receives the terminal message itself (`generation.ts:687`).
   - **NEW.**
5. **Stop re-providing a whole captured fiber context in `childRunLoop.ts`.**
   - Red flag: a context object that shadows more specific provisions, against the root `AGENTS.md` `Context.pick` rule.
   - Change: provide the named services `buildTurnResult` and `recordLastTurn` need, or run them on the child's own context (`childRunLoop.ts:533,552,590`).
   - Net: about 0 lines. It removes an unknown unknown.
   - Peer evidence: none needed; this is TeXRA's own rule.
   - **NEW.**

The remaining forwarders are already covered by queued work. `Inbox.admit` (`Inbox.ts:269`) falls under follow-up S3/S4 (**row 8**), and `guardedToolCall` (`toolGuard.ts:115`) is rewritten by #14413 (**row 5**).

## 4. What TeXRA should refuse

- **pi's explicit `Context` argument and `(task, runtime, context)` phase triples.** The Effect fiber context already gives cancellation and telemetry without 437 pass-through declarations. Phases over a `TaskRuntime` are the flow engine `AGENTS.md` rules out.
- **pi-agent's per-run config copied from public mutable hook fields** (`agent.ts:476-516`). It turns every hook into a field and every run into a bag.
- **DSH waterfall decorators for retry, checkpoint and approval.** They keep the loop short by moving its write-point guarantees into mountable listeners. TeXRA's write points belong in the owning path (`toolUseDispatch.ts:546-552`, `ModelInvoker.ts` attempt rows).
- **Package explosion to reach a zero-cycle graph.** DSH needs 369 packages and a 65-entry profile (`bundle/sdk-minimal/cordis.patch.yml`). TeXRA should reach a DAG by moving ports down and built-ins out (row 12), with the existing edge ratchet.
- **Forwarding methods on `Run` or `Session` for individual request kinds.** These would add pass-through methods; the PRD already rejects them.

## 5. Corrections

- **Row 5 (#14413) does not shrink the agent/tools cycle.** It centralizes the decision. On main and in the #14413 diff, the ask still goes through `requireRun` and `sessionOf` from `tools/approval/bashApproval.ts`, so the agent → tools → agent hop remains.
- **The baseline figure needs its split.** "252 names on edges that point up or sideways" is verified: 19 edges and 8 two-way pairs, as the PRD says. Of the 252, 97 are type-only and 155 are value names. The agent/tools pair accounts for 117 (46%), so it dominates the problem, not `platform`.
- **pi's guarantees are a library's, not its CLI's.** The prior review and the PRD's "(pi)" borrowings describe pi-durable. pi's shipped coding-agent does not depend on it (`packages/coding-agent/package.json`). It retries in the host class and persists by event observer, so pi's guarantees should not be attributed to its CLI.
- **DSH's zero two-way dependencies are confirmed (0 of 369 packages), with a caveat.** The graph is acyclic but not ordered by abstraction (`dsh-tools` → `dsh-user-approval`). It is evidence for "no cycles", not for "one layer order".
