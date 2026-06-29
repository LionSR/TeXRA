# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). It is organized by bounded concern so the
ubiquitous language is visible in the directory layout rather than buried in a
flat folder.

| Module        | Concern                          | Contents                                                                                                                                                                       |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `definition/` | What an agent **is** (configure) | `AgentDataclass` (settings, prompts, `AgentDefinition`, `AgentCategory`), `AgentConfig` (launch/run configuration + payload), `AgentCycleOptions` (template variable channels) |
| `state/`      | Run-state snapshots              | `AgentWorkspaceState`, `AgentState` (run/round snapshots + metrics), `TaskState` (workflow vs tool-use), `executionRequests` (request validation)                              |
| `usage/`      | Usage value objects              | `ResponseUsage`, `RunUsageAccumulator`                                                                                                                                         |
| `tools/`      | Tool contracts                   | `ToolTypes` (`ITool`, `IToolRegistry`, `MapToolRegistry`)                                                                                                                      |
| `flows/`      | Reusable cycle primitives        | `ResponseCycleFlow`, `ToolUseRoundFlow` (one LLM invocation + tool dispatch), and their shared services/types                                                                  |

## Dependency direction

Dependencies point **inward**, never the reverse:

```
flows ──▶ state ──▶ definition
              └────▶ usage
```

`state` may depend on `definition` and `usage`; `definition` and `usage`
depend on neither. Don't introduce imports that point back outward (e.g.
`definition` importing from `state`).

Files kept at the `core/` root are limited infrastructure helpers or shared
constants, not domain types:

- `constants.ts` — shared preview/threshold constants.

For bootstrap-tolerant state access before `initPlatform()` runs, use
`tryWorkspaceState()` / `tryGlobalState()` from `@platform/platform` — they
are the single home for all pre-init platform accessors.

## Importing

Use the `@agent/core/<module>/<File>` alias, e.g.

```ts
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TaskState } from '@agent/core/state/TaskState';
```

There is intentionally no `@agent/core` barrel — import from the specific
module so dependency edges stay explicit (and re-export shims are not left
behind, per the repo's anti-shim convention).
