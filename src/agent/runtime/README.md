# Agent runtime modules

`agent/runtime` is the host-agnostic execution layer that sits on top of
`agent/core`'s domain model: it launches, tracks, resumes, and reports on
agent runs. Where `core` is addressed entirely through module paths
(`definition/`, `state/`, `tools/` — see `src/agent/core/README.md`), this
directory is ~50 files at its top level plus the two subdirectories the
Effect-4 cutover earned, `run/` and `loop/` — see
[Why most of this stays flat](#why-most-of-this-stays-flat). So this README is
the module map the top level would otherwise lack: it documents the logical
groupings by concern so the shape is visible without opening every file.

| Group                             | Concern                                                          | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch & configuration**        | Resolve what a run should do before it starts                    | `AgentLaunchContext`, `agentToolResolution` (effective tool list, built from the run's tool composition), `selectAutoOpenFinalOutput` (post-run auto-open policy), `runLaunchGuard` (the terminal a run's launch owns: backstop `run.end`, final artifacts, claim), `AgentEngine` (the recursive agent entry points, supplied once by the process root)                                                                                                                                                                                            |
| **Run orchestration & resume**    | Entry points that start or resume a run, and their result shapes | `runAgent` (top-level entry: assigns the `runId`, registers, runs), `executeAgent` (lower-level execution + tool-use resume), `AgentRunLifecycle` (completion side effects, error classification), `RunEndResult` (a flow's `run.end` payload, still an in-memory hand-off, used for post-flow chaining), `resumeRun` (the cross-host resume entry: workflow, queued tool-use, and snapshot paths), `resumeToolUseFromResumeData` (persisted tool-use session resume, defined in `executeAgent`), `SessionResumeRetrieval` (persisted resume data) |
| **Run registry & live handles**   | Track, interrupt, and tear down in-flight runs                   | `RunHandle` (the live handle type plus run-owned interrupt capability), `runRegistry` (one entry per run — fiber, handle, child activation, serial lane — the single in-process liveness authority, with admission, registration, lookup and the stop gestures), `runStop` (a stop's contract: child policy, reason and settlement), `detachSubagentsOnStop` (detach-vs-cascade policy)                                                                                                                                                            |
| **Session, event hub & emission** | The per-session event contract and its direct host paths         | `runtimePresentationEvents` (typed presentation events and emit options), `SessionHandle` (one composition record per session), `SessionEvents` (the session's event plane: one publisher under one permit, the three reads, and the trace-to-fact translation), `sessionGraph` (the port a process entry installs the session graph opener through), `terminalResultToast`                                                                                                                                                                        |
| **Host interactions**             | Session-scoped host capabilities                                 | `HostInteractions` / `SessionHostInteractions` (session-owned host interaction and presentation port: diagnostics, manual criticism, unavailable-tool notices, plan approval, agent proposal, retry, bash, tool-edit, user question, external inquiry)                                                                                                                                                                                                                                                                                             |
| **Run history & services**        | What the loop takes from context to read, write and call         | `RunHistory` (claims and reads through `Database`, writes through `SessionEvents.publish`), `FollowUps` (pending follow-up input and its one-transaction consume), `ModelInvoker` (the one service that calls the llm `Model`), `storedTurn` (turn and history conversion at the run history boundary), `ToolCall` and `ToolServices` (capabilities scoped to one tool invocation)                                                                                                                                                                 |
| **Child runs & model cells**      | Drive a child run's turns and the model instance each turn uses  | `childRunLoop` (the single driver for every child-run type), `childRunBudget` (per-session child-run concurrency budget), `ModelRetryGate` (session-shared recovery probes for a model route), `responseTextProcessing` (host policy for provider-output cleanup and continuation joining), `nativeSubagentStrategy` (native launch options and result formatting), `subagentResults` and `deliveryEnvelope` (the XML delivery envelope every child path builds)                                                                                   |
| **Classification & control**      | Classify what a persisted run was and queue control over it      | `runClassification` (`classifyRun`, exported from the barrel), `runApprovalQueue` (per-run approval queueing), `requestPolicy` (what the session's approval policy settles when a request opens)                                                                                                                                                                                                                                                                                                                                                   |
| **Model resolution**              | Turn a model name/config into a bound llm `Model`                | `modelRoutes` (route, credential and backend resolution), `run/modelBinding` (`bindModel`, the one model path), `run/validationModel` (the CI-only canned model and its gate), `helperModel` (`helperModel` + `helperCall`, the one-shot helper path over `bindModel`, gated, priced and usage-logged like every model call), `helperModelName`, `helperModelPreference` (the "fix LaTeX" flag)                                                                                                                                                    |
| **Content helpers**               | One-shot content generation built on the helper model            | `sessionDescription` (AI session summary), `bundledPrompts` (the inline polish instruction and goal continuation), `textEnhancement` (polish orchestration), `mediaVisionWarning` (vision-support warning for attached media)                                                                                                                                                                                                                                                                                                                      |

Native children keep one run scope and live handle across follow-ups. The shared
child-run driver admits and delivers each turn; its concurrency permit covers
active work and is released while the child waits for input. Recovery from a
persisted run enters that same driver.

## Why most of this stays flat

`core`'s split works because each module's files are addressed through the
module path (`@agent/core/<module>/<File>`), so moving a file only means
updating the few imports that reference it. Most runtime files still have many
direct consumers inside `src/agent`, the agent SDK package, and tests. Moving
them into subdirectories would therefore create mechanical churn
disproportionate to a documentation change. The CLI, desktop, and extension
hosts are decoupled from that layout through the curated `@agent/runtime`
surface, but the internal direct imports remain a reason to keep the rest of
this directory flat.

The exception this section has always named — "if a future refactor touches a
whole group's internal call sites anyway, revisit turning that group into a
real subdirectory" — is what produced the two subdirectories. The Effect-4
cutover rewrote those call sites wholesale, so the run program
(`loop/toolUse`, over `loop/runProgram`, `loop/rows` and
`loop/toolUseDispatch`) and the per-run services it takes from context (`run/AgentRun`,
`run/modelBinding`, `run/pricing`, `run/turnText`, …) became real
subdirectories rather than more top-level files. That same bar — a refactor
already touching the whole group — governs any further one.

## Importing

CLI, desktop, and extension host code imports the curated public surface:

```ts
import { runAgent, retrieveSessionResumeData } from '@agent/runtime';
```

The barrel contains only symbols used across that host boundary. A type a
host needs but the barrel does not export is derived from an exported
function's return type — the CLI does exactly that for the tool-use resume
snapshot (`packages/cli/src/runtime/toolUseResumeData.ts`). Code inside
`src/agent`, the agent SDK package, and tests should continue importing the
specific `@agent/runtime/<File>` module so internal dependency edges stay
explicit and the host-facing surface does not become a convenience barrel.
