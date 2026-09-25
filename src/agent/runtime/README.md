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

| Group                                | Concern                                                          | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch & configuration**           | Resolve what a run should do before it starts                    | `AgentLaunchContext`, `agentLoad` (resolve + load agent YAML), `agentToolResolution` (effective tool list, built from the run's tool composition), `selectAutoOpenFinalOutput` (post-run auto-open policy)                                                                                                                                                                                                                                                                                                                                            |
| **Run orchestration & resume**       | Entry points that start or resume a run, and their result shapes | `runAgent` (top-level entry: assigns the `runId`, registers, runs), `executeAgent` (lower-level execution + tool-use resume), `AgentRunLifecycle` (completion side effects, error classification), `AgentFlowResult` (a flow's `run.end` payload, still an in-memory hand-off, used for post-flow chaining), `resumeRun` (the cross-host resume entry: workflow, queued tool-use, and snapshot paths), `resumeToolUseFromResumeData` (persisted tool-use session resume, defined in `executeAgent`), `SessionResumeRetrieval` (persisted resume data) |
| **Run registry & live handles**      | Track, interrupt, and tear down in-flight runs                   | `RunHandle` (the live handle type plus run-owned interrupt capability), `runRegistry` (the session-facing surface: admission, registration, lookup and the stop gestures), `runRoster` (one entry per run — handle, child activation, lifecycle lane — the single in-process liveness authority), `runStopping` (what a stop does with those records), `detachSubagentsOnStop` (detach-vs-cascade policy)                                                                                                                                             |
| **Session, event hub & emission**    | The per-session event contract and its direct host paths         | `HostInteractions` / `SessionHostInteractions` (the session-owned interaction and presentation path), `runtimePresentationEvents` (typed presentation events and emit options), `SessionHandle` (one composition record per session), `SessionEvents` (the session's event plane: one publisher under one permit, the three reads, and the trace-to-fact translation), `sessionGraph` (the port a process entry installs the session graph opener through), `terminalResultToast`, `UsageMonitor` (per-round usage event + backend usage logging)     |
| **Run identity & host interactions** | Per-run identity and session-scoped host capabilities            | `RunScope` (canonical run identity + owning session, carried by `AgentLaunchContext`), `HostInteractions` (session-owned host interaction port: diagnostics, manual criticism, unavailable-tool notices, plan approval, agent proposal, retry, bash, tool-edit, user question, external inquiry)                                                                                                                                                                                                                                                      |
| **Child runs & model cells**         | Drive a child run's turns and the model instance each turn uses  | `childRunLoop` (the single driver for every child-run type), `childRunBudget` (per-session child-run concurrency budget), `ModelRetryGate` (session-shared recovery probes for a model route), `agentSettingTools` (per-agent tool settings), `responseTextProcessing` (host policy for provider-output cleanup and continuation joining)                                                                                                                                                                                                             |
| **Classification & control**         | Classify what a persisted run was and queue control over it      | `runClassification` (`classifyRun`, exported from the barrel), `runApprovalQueue` (per-run approval queueing), `workflowControlRegistry` (workflow-script grandchild skip/retry control)                                                                                                                                                                                                                                                                                                                                                              |
| **Model resolution**                 | Turn a model name/config into a bound llm `Model`                | `modelRoutes` (route, credential and compatibility-key resolution), `run/modelBinding` (`bindModel`, the one model path), `run/validationModel` (the CI-only canned model and its gate), `helperModel` (`helperModel` + `helperCompletion`, the unmetered one-shot helper path over `bindModel`), `helperModelName`, `helperModelPreference` (the "fix LaTeX" flag), `textConnection` (helper-model connector for LaTeX continuation joining)                                                                                                         |
| **Content helpers**                  | One-shot content generation built on the helper model            | `sessionDescription` (AI session summary), `bundledPrompts` (the inline polish instruction and goal continuation), `textEnhancement` (polish orchestration), `mediaVisionWarning` (vision-support warning for attached media)                                                                                                                                                                                                                                                                                                                         |

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
cutover rewrote those call sites wholesale, so the run programs
(`loop/toolUse`, `loop/reflection`, over `loop/rows` and `loop/toolUseDispatch`)
and the per-run services they take from context (`run/AgentRun`,
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
