# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). It is organized by bounded concern so the
ubiquitous language is visible in the directory layout rather than buried in a
flat folder.

| Module        | Concern                          | Contents |
| ------------- | -------------------------------- | -------- |
| `definition/` | What an agent **is** (configure) | `AgentDataclass` (settings, prompts, `AgentDefinition`, `AgentCategory`), `AgentConfig` (launch/run configuration + payload), `AgentCycleOptions` (template variable channels) |
| `execution/`  | A **running** agent (run state)  | `AgentWorkspaceState`, `AgentState` (run/round snapshots + metrics), `TaskState` (workflow vs tool-use), `executionRequests` (request validation) |
| `usage/`      | Usage value objects              | `ResponseUsage`, `RunUsageAccumulator` |
| `tools/`      | Tool contracts                   | `ToolTypes` (`ITool`, `IToolRegistry`, `MapToolRegistry`) |
| `flows/`      | Reusable cycle primitives        | `ResponseCycleFlow`, `ToolUseCycleFlow`, and their shared services/types |

## Dependency direction

Dependencies point **inward**, never the reverse:

```
flows ──▶ execution ──▶ definition
                └──────▶ usage
```

`execution` may depend on `definition` and `usage`; `definition` and `usage`
depend on neither. Don't introduce imports that point back outward (e.g.
`definition` importing from `execution`).

Files kept at the `core/` root are thin infrastructure facades or shared
constants, not domain types:

- `config.ts`, `stateStore.ts` — platform facades over `@platform`.
- `constants.ts` — shared preview/threshold constants.

## Importing

Use the `@agent/core/<module>/<File>` alias, e.g.

```ts
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TaskState } from '@agent/core/execution/TaskState';
```

There is intentionally no `@agent/core` barrel — import from the specific
module so dependency edges stay explicit (and re-export shims are not left
behind, per the repo's anti-shim convention).
