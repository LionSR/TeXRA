# Agent runtime modules

`agent/runtime` is the host-agnostic execution layer over `agent/core`: it
launches, tracks, resumes and reports on runs. Its top level is flat, so this
is the module map by concern. Run-loop rules are in
`packages/harness/AGENTS.md` "Run loop architecture".

## Subdirectories

- `loop/`: the run program. `toolUse` and `toolUseDispatch` (the loop),
  `runProgram` (`RunCell`, the run's one state holder and writer), `rows`
  (every draft the loop appends), `step` (where tools and prompt contributions
  change, and the change is recorded), `hooks` (plugin hooks at loop points),
  `toolGuard` (path checks and command approval before a tool body),
  `modelSwitch` (a host's model switch, applied at the next model call).
- `run/`: the per-run services the loop takes from context. `AgentRun`,
  `invocation` (the one model-call retry loop), `modelCall`, `pricing`,
  `compaction`, `contextTokens`, `mediaInput`, `tools`, `turnText`,
  `toolResultText`, `requestContext`, `backgroundTurn`, and `validationModel`
  (the CI-only canned model).
- `modelAccess/`: the one path from settings to a bound llm `Model`
  (`ModelAccess`, `binding`, `credentials`, `routeDecision`, `failureInfo`).
- `historyQuery/`: the model's read-only SQL over a session's display rows, in
  a child-process store holding only copied rows.

## Top-level modules

- **Launch and configuration**: `AgentLaunchContext`; `agentToolResolution`
  (the effective tool list); `runLaunchGuard` (the run's terminal `run.end`
  and claim, including a held child's end).
- **Start and resume**: `rootLaunch` (what `Runs.launch({ request, options })`
  runs: assigns the `runId`, registers, runs); `executeAgent` (lower-level
  execution and `resumeToolUseFromResumeData`); `AgentRunLifecycle`
  (completion side effects, error classification); `RunEndResult`;
  `resumeRun` (the cross-host resume entry, root or recovered child);
  `forkRun` (a new root seeded from another run's view); `resumeBlocker` (a
  missing or untrusted agent).
- **Registry and live handles**: `runRegistry` (one entry per run: fiber,
  handle, child activation, serial lane; the single in-process liveness
  authority, with admission, lookup and stop); `runs` (the session's `Runs`
  as hosts and tools see them); `RunHandle`; `detachSubagentsOnStop`.
- **Session events**: `SessionHandle` (one composition record per session);
  `SessionEvents` (one publisher, the reads, and trace-to-fact translation);
  `runtimePresentationEvents`; `terminalResultToast`; `HostInteractions` /
  `SessionHostInteractions` (the session's host port: diagnostics, approvals,
  retries, user questions, external inquiry, and other notices).
- **History and per-call services**: `RunHistory` (claims through
  `Database`, reads and writes through `SessionLog`); `FollowUps` (pending
  follow-up input, consumed one batch at a time); `ModelInvoker` (the one
  caller of the llm `Model`); `storedTurn` (turn conversion at the history
  boundary); `RunCall` and `ToolServices` (one tool invocation's
  capabilities).
- **Child runs**: `childRunLoop` (the single driver for every child-run
  type); `childTurnResult` (a child turn's rows and its delivery to the
  parent, in one transaction); `childRunBudget` (per-session concurrency);
  `ModelRetryGate` (process-shared recovery probes per model route);
  `nativeSubagentStrategy`; `scriptRun`; `recipeResult`; `subagentResults` and
  `deliveryEnvelope` (the XML envelope every child path builds).
- **Classification and control**: `runClassification`; `runApprovalQueue`;
  `requestPolicy` (what the approval policy decides when a request opens).
- **Helper model**: `helperModel` (`helperCall`, the gated, priced and logged
  one-shot path through `ModelAccess`); `helperModelName`;
  `sessionDescription` (the AI session summary).

A native child keeps one run scope and live handle across follow-ups. The
child-run driver accepts and delivers each turn; its concurrency permit is
released while the child waits for input, and recovery of a persisted run
enters the same driver.

## Why the top level stays flat

Most of these files have many direct importers in the harness and the tests,
so moving them is churn without a design gain. A group becomes a
subdirectory only when a refactor already rewrites its call sites, as the
Effect 4 cutover did for `loop/` and `run/`. Hosts import nothing from here:
they hold the public `LocalSession` (`@texra-ai/harness`). Harness code
imports the specific `@agent/runtime/<File>` module; there is no barrel.
