# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). Three modules remain, named after the
concern they carry:

| Module        | Concern                          | Contents                                                                                                                                                                                                                      |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition/` | What an agent **is** (configure) | `AgentDataclass` (settings, prompts, `AgentDefinition`, `AgentCategory`), `AgentConfig` (launch/run configuration + payload), `AgentCycleOptions` (typed template-variable tokens), `agentDefinitionInheritance`, `RunRecord` |
| `state/`      | Run-state snapshots              | `AgentWorkspaceState` (file, media and work-plan state) and `runRequests` (request validation)                                                                                                                                |
| `tools/`      | Tool contracts and tool calls    | `ToolTypes` (`ToolHost`, `ITool`, `IToolRegistry`, `MapToolRegistry`), `toolAttachmentExtraction`, `toolCallParsing` (duplicate-call partitioning and tool-call error normalization, used by both run programs)               |

What is **not** here, and where it lives instead:

- The run snapshot and the run usage totals are schemas, not classes:
  `runFlowState.ts` and `usage.ts` in `@shared/schemas`. There is no usage
  accumulator type in `core`.
- The run programs are `@agent/runtime/loop/` (`toolUse.ts`, `reflection.ts`),
  their per-run services `@agent/runtime/run/`, the model call
  `@agent/runtime/ModelInvoker.ts`. `core` holds none of the loop.
- The process's global state store is the `AppState` service from
  `@platform/interfaces` (`yield* AppState` in Effect code, or thread the store
  in from the host's composition root). Workspace-scoped state comes from
  `workspaceRoots().workspaceState`.

## Dependency direction

The only edge inside `core` is `state` → `definition` (`runRequests` validates
an `AgentConfig`). `definition` and `tools` depend on nothing else in `core`;
don't introduce an edge that points back outward.

That covers dependencies _within_ `core`. Any module here may still call a
canonical host-agnostic collaborator outside `core` directly rather than take a
second reference to the same run-owned service; that is not a `core`-specific
exception, and it is still host-agnostic.

## Importing

Inside `src/agent`, use the `@agent/core/<module>/<File>` alias, e.g.

```ts
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { validateRunRequest } from '@agent/core/state/runRequests';
```

There is intentionally no top-level `@agent/core` barrel — internal `src/agent`
code imports from the specific module so dependency edges stay explicit (and
re-export shims are not left behind, per the repo's anti-shim convention).

Cross-host consumers (CLI, desktop, extension) that need the stable config
contract reach the already-approved `@agent/runtime` barrel:
`AgentConfigSchema`, `AgentConfig`, `AgentConfigPayload`, and the run-request
validation (`validateRunRequest`, `RunRequest`, `ValidatedRunRequest`).
