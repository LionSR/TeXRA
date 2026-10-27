# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system: no
`vscode`, no imports from other packages.

| Module        | Concern                          | Contents                                                                                                                                                                                                               |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition/` | What an agent **is** (configure) | `AgentConfig` (launch and run configuration plus payload), `RunRecord`. The definition format (`AgentDefinition`, `Persona`) is a schema in `@shared/schemas` (`agent.ts`); a plugin's block is its own (`AgentBlock`) |
| `tools/`      | Tool contracts and tool calls    | `ToolTypes` (`ITool`, `ToolContext`), `toolAttachmentExtraction`, `toolCallParsing` (duplicate-call partitioning and tool-call error normalization for the run loop)                                                   |

`definition/` and `tools/` do not depend on each other; keep it that way.

Not here:

- Run facts and usage totals are schemas (`runFacts.ts`, `usage.ts` in
  `@shared/schemas`); the state the loop continues from is `RunState`
  (`@shared/session/runState`), rebuilt from rows.
- The run program, its per-run services and the model call are in
  `@agent/runtime` ([`../runtime/README.md`](../runtime/README.md)).
- Global state is the `AppState` service (`@platform/interfaces`);
  workspace state is the `roots.workspaceState` the caller holds.

## Importing

Harness code imports the specific module (`@agent/core/definition/AgentConfig`);
there is no `@agent/core` barrel. The `AgentConfigSchema` wire contract comes
from `@shared/schemas` inside the harness and from `@texra-ai/harness/schemas`
outside it. Run-request validation (`validateRunRequest`) is the app's, in
`packages/texra/src/controllers/session/runRequests.ts`.
