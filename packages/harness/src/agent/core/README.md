# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). Two modules remain, named after the
concern they carry:

| Module        | Concern                          | Contents                                                                                                                                                                                                            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition/` | What an agent **is** (configure) | `AgentConfig` (launch/run configuration + payload), `RunRecord`; the definition format itself (`AgentDefinition`, `Persona`) is a schema in `@shared/schemas` (`agent.ts`), a plugin's block its own (`AgentBlock`) |
| `tools/`      | Tool contracts and tool calls    | `ToolTypes` (`ITool`, `IToolRegistry`, `MapToolRegistry`, `ToolContext`), `toolAttachmentExtraction`, `toolCallParsing` (duplicate-call partitioning and tool-call error normalization, used by the run loop)       |

What is **not** here, and where it lives instead:

- The run snapshot and the run usage totals are schemas, not classes:
  `runSnapshotState.ts` and `usage.ts` in `@shared/schemas`. There is no usage
  accumulator type in `core`.
- The run program is `@agent/runtime/loop/toolUse.ts` (a task's recipe, a
  plugin's script, runs as its one call), its
  per-run services `@agent/runtime/run/`, the model call
  `@agent/runtime/ModelInvoker.ts`. `core` holds none of the loop.
- The process's global state store is the `AppState` service from
  `@platform/interfaces` (`yield* AppState` in Effect code, or thread the store
  in from the host's composition root). Workspace-scoped state comes from the
  `roots.workspaceState` the caller holds — a tool call's `call.env.roots`, a
  run's `session.roots`, a host command's `session.roots`.

## Dependency direction

`definition` and `tools` depend on nothing else in `core`; don't introduce an
edge between them.

That covers dependencies _within_ `core`. Any module here may still call a
canonical host-agnostic collaborator outside `core` directly rather than take a
second reference to the same run-owned service; that is not a `core`-specific
exception, and it is still host-agnostic.

## Importing

Inside `packages/harness/src/agent`, use the `@agent/core/<module>/<File>` alias, e.g.

```ts
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
```

There is intentionally no top-level `@agent/core` barrel — internal `packages/harness/src/agent`
code imports from the specific module so dependency edges stay explicit (and
re-export shims are not left behind, per the repo's anti-shim convention).

Code outside the harness takes the config contract (`AgentConfigSchema`,
`AgentConfig`, `AgentConfigPayload`, `AgentConfigInput`) from
`@texra-ai/harness/schemas`. Run-request validation (`validateRunRequest`,
`RunRequest`, `ValidatedRunRequest`) is the app's, in
`packages/texra/src/controllers/session/runRequests.ts`.
