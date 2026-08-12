# Agent runtime modules

`agent/runtime` is the host-agnostic execution layer that sits on top of
`agent/core`'s domain model: it launches, tracks, resumes, and reports on
agent runs. Unlike `core` (recently split into `definition/state/usage/tools/flows/`,
see `src/agent/core/README.md`), this directory stays a flat list of ~50
files — see [Why this stays flat](#why-this-stays-flat) — so this README is
the module map that directory would otherwise provide: it documents the
logical groupings by concern so the shape is visible without opening every
file.

| Group                                 | Concern                                                          | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Launch & configuration**            | Resolve what a run should do before it starts                    | `AgentLaunchContext`, `agentLoad` (resolve + load agent YAML), `agentToolResolution` (effective tool list pipeline), `toolInjection` (conditional tool auto-injection registry), `selectAutoOpenFinalOutput` (post-run auto-open policy)                                                                                                                                                                                                                                 |
| **Run orchestration & resume**        | Entry points that start or resume a run, and their result shapes | `runAgent` (top-level entry: assigns `executionId`, registers, runs), `executeAgent` (lower-level execution + tool-use resume), `AgentRunLifecycle` (completion side effects, error classification), `AgentFlowResult` (internal flow result), `AgentFinalResult` (post-flow chaining envelope), `resolveAndResumeStream` (cross-host resume skeleton), `resumeQueuedToolUse`, `resumeToolUseSnapshot`, `SessionResumeRetrieval` (persisted resume data)                 |
| **Execution registry & live handles** | Track, interrupt, and tear down in-flight executions             | `AgentExecutionHandle` (the live handle type plus run-owned interrupt capability), `executionRegistry` (registration, lookup, subagent lineage), `ExecutionSubscriptionBinder` (stream ↔ execution-status subscriptions), `InterruptManager`, `agentShutdown` (host teardown), `detachSubagentsOnStop` (detach-vs-cascade policy)                                                                                                                                        |
| **Session, event hub & emission**     | The per-session event contract and its direct host paths         | `HostInteractions` / `SessionHostInteractions` (the session-owned interaction and presentation path), `runtimePresentationEvents` (typed presentation events and emit options), `SessionHandle` (one composition record per session), `SessionEventHub` (typed session facts emitted through the owning session), `runFactEvents` (run-fact domain event names), `StreamStatusService` (stream status state machine), `streamTab` (stream tab id), `terminalResultToast` |
| **Run context & host interactions**   | Ambient per-run context and session-scoped host capabilities     | `RunScope` (canonical run identity + owning session, carried by `AgentLaunchContext` and by `launch`-kind `RunContext`), `RunContext` (`AsyncLocalStorage`-based ambient context), `HostInteractions` (session-owned host interaction port: diagnostics, manual criticism, unavailable-tool notices, plan approval, agent proposal, retry, bash, tool-edit, user question, external inquiry)                                                                             |
| **Model resolution**                  | Turn a model name/config into a handler instance                 | `ModelFactory` (provider handler factory), `modelHandlerCompatibilityKey`, `modelHandlerCompatibilityInference`, `internalValidationOverride` (CI-only stub swap), `helperModel`, `helperModelName`, `helperModelPreference` (the "fix LaTeX" flag), `textConnection` (direct-client helper-model connection for LaTeX commands)                                                                                                                                         |
| **Content helpers**                   | One-shot content generation built on the helper model            | `sessionDescription` (AI session summary), `polishModel` (polish prompt template), `textEnhancement` (polish orchestration), `mediaVisionWarning` (vision-support warning for attached media)                                                                                                                                                                                                                                                                            |

## Why this stays flat

`core`'s split works because each module's files are addressed through the
module path (`@agent/core/<module>/<File>`), so moving a file only means
updating the few imports that reference it. `runtime` files are the opposite:
~180 files across `src/` and `packages/*` import a specific
`@agent/runtime/<File>` path directly (there is no barrel — see
[Importing](#importing)), so physically moving any of these files into
subdirectories means rewriting every one of those call sites. That's
mechanical churn disproportionate to a documentation change, not a "natural"
low-risk split — hence a README module map instead of a directory split. If a
future refactor touches a whole group's call sites anyway, revisit turning
that group into a real subdirectory.

## Importing

Import each file directly by its `@agent/runtime/<File>` path, e.g.:

```ts
import { runAgent } from '@agent/runtime/runAgent';
import { executionRegistry } from '@agent/runtime/executionRegistry';
```

There is intentionally no `@agent/runtime` barrel, matching `core`'s
no-barrel convention — import from the specific file so dependency edges stay
explicit and no re-export shim needs to be maintained.
