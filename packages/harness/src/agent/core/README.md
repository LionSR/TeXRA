# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system: no
`vscode`, no imports from other packages.

| Module   | Concern                       | Contents                                                                                                                                                                                                                       |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/` | Tool contracts and tool calls | `ToolTypes` (`ITool`, `ToolContext`), `toolAttachmentExtraction`, `toolCallParsing` (duplicate-call partitioning and tool-call error normalization for the run loop), `toolSchema` (a tool's JSON Schema as the model sees it) |

Not here:

- A run's record (`RunRecord`, `runRecords.ts`), run facts and usage totals are schemas (`runInput.ts`, `usage.ts` in
  `@shared/schemas`); the state the loop continues from is `RunState`
  (`@shared/session/runState`), rebuilt from rows.
- The run program, its per-run services and the model call are in
  `@agent/runtime` ([`../runtime/README.md`](../runtime/README.md)).
- Global state is the `AppState` service (`@platform/interfaces`);
  workspace state is the `roots.workspaceState` the caller holds.

## Importing

Harness code imports the specific module (`@agent/core/tools/ToolTypes`);
there is no `@agent/core` barrel. The `AgentConfigSchema` wire contract comes
from `@shared/schemas` inside the harness and from `@texra-ai/harness/schemas`
outside it. Decoding a launch's configuration (`decodeLaunchConfig`) is the
app's, in `packages/texra/src/controllers/session/launchConfig.ts`.
