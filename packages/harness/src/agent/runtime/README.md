# Agent runtime modules

`agent/runtime` is the host-agnostic execution layer over the run's rows
(`shared/session/`) and the tool contract (`tools/core/`): it launches, tracks, resumes and reports on runs. Its top level is flat, so this
is the module map by concern. Run-loop rules are in
`packages/harness/AGENTS.md` "Run loop architecture". Each entry links its
file, so `npm run gate:docs` fails when one moves.

## Subdirectories

- `loop/`: the run program.
  [`runLoop`](loop/runLoop.ts) (the run's entry, which opens its cell, the
  loop, and the exit every run takes) and
  [`toolUseDispatch`](loop/toolUseDispatch.ts) (a response's tool calls);
  [`rows`](loop/rows.ts) (every draft the loop appends);
  [`step`](loop/step.ts) (where tools and prompt contributions change, and
  the change is recorded); [`hooks`](loop/hooks.ts) (plugin hooks at loop
  points); [`toolGuard`](loop/toolGuard.ts) (hooks, path checks and command
  approval before a tool body); [`modelSwitch`](loop/modelSwitch.ts) (a
  host's model switch, applied at the next model call).
- `run/`: the per-run services the loop takes from context.
  [`AgentRun`](run/AgentRun.ts), [`modelCall`](run/modelCall.ts) (a model
  call off the run's rows), [`pricing`](run/pricing.ts),
  [`compaction`](run/compaction.ts), [`contextTokens`](run/contextTokens.ts),
  [`mediaInput`](run/mediaInput.ts) and [`img`](run/img.ts) (a launch's
  media as model input), [`tools`](run/tools.ts),
  [`recordedRequest`](run/recordedRequest.ts), and
  [`backgroundTurn`](run/backgroundTurn.ts).
- `modelAccess/`: the one path from settings to a bound llm `Model`
  ([`ModelAccess`](modelAccess/ModelAccess.ts),
  [`binding`](modelAccess/binding.ts),
  [`credentials`](modelAccess/credentials.ts),
  [`routeDecision`](modelAccess/routeDecision.ts),
  [`failureInfo`](modelAccess/failureInfo.ts)).
- `delegation/`: the child launches: [`AgentTool`](delegation/AgentTool.ts)
  (the `agent` tool), [`childLaunch`](delegation/childLaunch.ts) (how a
  call launches and awaits a native child),
  [`subagentRun`](delegation/subagentRun.ts) (a detached child),
  [`agentChild`](delegation/agentChild.ts) (the child a call answers from),
  [`bashDelivery`](delegation/bashDelivery.ts) (what a background command
  delivers), [`proposalFlow`](delegation/proposalFlow.ts) and
  [`delegationAvailability`](delegation/delegationAvailability.ts) (what a
  child may run, and the approval before it does),
  [`inputFields`](delegation/inputFields.ts).
- `historyQuery/`: the model's read-only SQL over a session's display rows, in
  a child-process store holding only copied rows.

## Top-level modules

- **Launch and configuration**: [`AgentLaunchContext`](AgentLaunchContext.ts)
  (the definition a launch resolves before its run exists: agent, tools,
  model, or the agent this process cannot run);
  [`agentToolResolution`](agentToolResolution.ts) (the effective tool list);
  [`leftoverChildren`](leftoverChildren.ts) (what a process that exited
  left of a run's children, finished as the parent resumes).
- **Start, resume and end**: [`rootLaunch`](rootLaunch.ts) (what
  `session.start` runs: registers the run under the id the start minted, and
  runs it; and `SessionServices`, every owner of a session);
  [`executeAgent`](executeAgent.ts) (the one run program, fresh or resumed:
  the run's entry, whether it ends after one cycle, its services, its
  description, and the masked region whose exit is its terminal);
  [`AgentRunLifecycle`](AgentRunLifecycle.ts) (the end: `endRun`, the
  terminal's classification of an exit, and `commitEnd`, the one end both
  run programs commit, through `agent/storage/runLifecycle`'s `endRunRows`);
  [`runReport`](runReport.ts) (a run's unclassified report to its
  terminal); [`resumeRun`](resumeRun.ts) (the cross-host resume entry, root
  or recovered child: the run's activation from the call, joined by a
  second resume); [`forkRun`](forkRun.ts) (a new root seeded from another
  run's view).
- **Registry**: [`runRegistry`](runRegistry.ts) (one entry per run: fiber,
  loop controls, activation, serial lane; the one in-process answer to which
  runs are launched here, published to the view as `runsHere`, with
  admission, lookup and stop); [`runs`](runs.ts) (the session's `Runs` as
  hosts and tools see them, and a loop's `RunControls`).
- **Session**: [`SessionHandle`](SessionHandle.ts) (what opening a session
  supplies, and the shape of its requests);
  [`sessionEventsLayer`](sessionEventsLayer.ts) (the session's event
  publisher over its SQLite database);
  [`makeRunHistory`](makeRunHistory.ts) (the run history over the session's
  log, and every run's cell);
  [`providerMessages`](providerMessages.ts) (turn and history values to and
  from their stored shapes, `shared/schemas/storedTurn.ts`);
  [`runtimePresentationEvents`](runtimePresentationEvents.ts);
  [`HostInteractions`](HostInteractions.ts) (`Interactions`, the session's
  host port: diagnostics, approvals, retries, user questions, plugin
  requests, and other notices, and what a failed run presents on it).
- **Per-run and per-call services**: [`FollowUps`](FollowUps.ts) (pending
  follow-up input, consumed one batch at a time);
  [`ModelInvoker`](ModelInvoker.ts) (the one caller of the llm `Model`);
  [`ModelRetryGate`](ModelRetryGate.ts) (process-shared recovery probes per
  model route); [`RunCall`](RunCall.ts) and
  [`ToolServices`](ToolServices.ts) (one tool invocation's capabilities).
- **Child runs**: [`processRun`](processRun.ts) (a process child: the one
  turn an external process is, and its end; a native child is
  `executeAgent` under a parent edge, which runs one cycle);
  [`childRunBudget`](childRunBudget.ts) (per-session concurrency);
  [`scriptRun`](scriptRun.ts) (a background script's report);
  [`programRun`](programRun.ts) (what a program run reports);
  [`childDelivery`](childDelivery.ts) (what a child's end delivers, typed)
  and [`deliveryEnvelope`](deliveryEnvelope.ts) (the one renderer of a
  delivery's XML envelope).
- **Control**: [`runApprovalQueue`](runApprovalQueue.ts) (a run's grants);
  [`requests`](requests.ts) (a run's questions to a person: opened through
  its cell with the policy's answer, decided once, cancelled with the run's
  end).
- **Helper model**: [`helperModel`](helperModel.ts) (`helperCall`, the
  gated, priced and logged one-shot path through `ModelAccess`);
  [`helperModelName`](helperModelName.ts) (the configured helper model,
  else the app catalog's default; with neither, a run's helper calls use its
  own model); [`sessionDescription`](sessionDescription.ts) (the AI session
  summary).

Every child is a run that ends: it runs one cycle, its `run.end` delivers
its report to its parent's input (unless the parent's call awaits it), and
a later message to it is a resume. A background child holds a permit of
the session's child-run budget for its whole run; an awaited one rides its
parent's (`executeAgent`).

## Why the top level stays flat

Most of these files have many direct importers in the harness and the tests,
so moving them is churn without a design gain. A group becomes a
subdirectory only when a refactor already rewrites its call sites, as the
Effect 4 cutover did for `loop/` and `run/`. Hosts import nothing from here:
they hold the public `LocalSession` (`@texra-ai/harness`). Harness code
imports the specific `@agent/runtime/<File>` module; there is no barrel.
