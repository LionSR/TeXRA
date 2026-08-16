# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). It is organized by bounded concern so the
ubiquitous language is visible in the directory layout rather than buried in a
flat folder.

| Module        | Concern                          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition/` | What an agent **is** (configure) | `AgentDataclass` (settings, prompts, `AgentDefinition`, `AgentCategory`), `AgentConfig` (launch/run configuration + payload), `AgentCycleOptions` (typed template-variable vocabulary + two-channel record)                                                                                                                                                                                                                                   |
| `state/`      | Run-state snapshots              | `AgentWorkspaceState`, `AgentState` (run/round snapshots + metrics), `executionRequests` (request validation), and `TaskState` + `agentConfigToTaskState` — **not** a live state model: `AgentConfig` is the run-config vocabulary, and `TaskState` is only the frozen wire shape of the CLI NDJSON `setTaskState` event, projected from `AgentConfig` at that one boundary                                                                   |
| `usage/`      | Usage value objects              | `RunUsageAccumulator` — accumulates already-normalized `NormalizedUsage` (`@agent/types/NormalizedUsage`). Raw per-provider usage payloads (`ProviderUsage`) are a `ModelHandler`/`IModelHandler` data contract and live in `@agent/types/ProviderUsage`, not here — `core/` never sees an unnormalized usage shape.                                                                                                                     |
| `tools/`      | Tool contracts                   | `ToolTypes` (`ITool`, `IToolRegistry`, `MapToolRegistry`)                                                                                                                                                                                                                                                                                                                                                                                     |
| `flows/`      | Shared cycle kernel              | Only what both flow families use: `ModelInvocationNode` (the model call and its retry lifecycle), `CommonCycleTypes`, `postCompactionContext`, `BaseFlowServices`, `FlowTransitions`, `CycleServices`, `IToolUseSession`, `toolCallParsing`. The family-specific flows live with their consumers — `ResponseCycleFlow` under `implementations/flows/reflection/`, `ToolUseRoundFlow` + `toolUseRound/` under `implementations/flows/tooluse/` |

## Dependency direction

Dependencies point **inward**, never the reverse:

```
flows ──▶ state ──▶ definition
              └────▶ usage
```

`state` may depend on `definition` and `usage`; `definition` and `usage`
depend on neither. Don't introduce imports that point back outward (e.g.
`definition` importing from `state`).

This diagram covers dependencies _within_ `core`. Flow files may still call a
canonical host-agnostic collaborator outside `core` directly instead of
injecting a second reference to the same run-owned service. For example,
`ModelInvocationNode.ts` reads the current session through its run scope and
calls `includedModelAccess()` for relay-401 token refresh. This
is the same pattern `@agent/modelHandlers` already uses, not a `core`-specific
exception. None of this pulls in `vscode` or `packages/*`; it's still
host-agnostic, just not self-contained within `core`'s own module boundaries.
Don't read the diagram above as "flow files never import outside `core`."

Files kept at the `core/` root are limited infrastructure helpers or shared
constants, not domain types:

- `constants.ts` — shared preview/threshold constants.

For bootstrap-tolerant state access before `initPlatform()` runs, use
`tryWorkspaceState()` / `tryGlobalState()` from `@platform/platform` — they
are the single home for all pre-init platform accessors.

## Importing

Inside `src/agent`, use the `@agent/core/<module>/<File>` alias, e.g.

```ts
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TaskState } from '@agent/core/state/TaskState';
```

There is intentionally no top-level `@agent/core` barrel — internal `src/agent`
code imports from the specific module so dependency edges stay explicit (and
re-export shims are not left behind, per the repo's anti-shim convention).

Cross-host consumers (CLI, desktop, extension) that need the stable config
contract reach the already-approved `@agent/runtime` barrel:
`AgentConfigSchema`, `AgentConfig`, and `AgentConfigPayload`.
