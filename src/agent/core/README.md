# Agent core domain modules

`agent/core` holds the host-agnostic domain model for the agent system (no
`vscode`, no `packages/*` imports). It is organized by bounded concern so the
ubiquitous language is visible in the directory layout rather than buried in a
flat folder.

| Module        | Concern                          | Contents                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition/` | What an agent **is** (configure) | `AgentDataclass` (settings, prompts, `AgentDefinition`, `AgentCategory`), `AgentConfig` (launch/run configuration + payload), `AgentCycleOptions` (typed template-variable tokens; the user-variable record now lives in `@shared/schemas` `runFlowState.ts`)                                     |
| `state/`      | Run-state snapshots              | `AgentWorkspaceState`, `AgentState` (round snapshot + metrics; the run snapshot moved to `@shared/schemas` `runFlowState.ts`), and `runRequests` (request validation) — **not** a live state model: `AgentConfig` is the one run-config vocabulary, and no boundary projects a second shape of it |
| `usage/`      | Usage value objects              | `RunUsageAccumulator` — accumulates already-normalized `NormalizedUsage` (`@shared/schemas`). Raw per-provider usage payloads (`ProviderUsage`) no longer cross into core flows and live in `@agent/types/ProviderUsage`; core never imports them.                                                |
| `tools/`      | Tool contracts                   | `ToolTypes` (`ITool`, `IToolRegistry`, `MapToolRegistry`)                                                                                                                                                                                                                                         |
| `flows/`      | Shared loop helpers              | Only what both run programs use: `toolCallParsing`. The programs themselves live in `@agent/runtime/loop/` (`toolUse.ts`, `reflection.ts`), their per-run services in `@agent/runtime/run/`, and the model call in `@agent/runtime/ModelInvoker.ts`                                               |

## Dependency direction

Dependencies point **inward**, never the reverse:

```
flows ──▶ state ──▶ definition
              └────▶ usage
```

`state` may depend on `definition` and `usage`; `definition` and `usage`
depend on neither. Don't introduce imports that point back outward (e.g.
`definition` importing from `state`).

This diagram covers dependencies _within_ `core`. A `flows/` helper may still
call a canonical host-agnostic collaborator outside `core` directly instead of
taking a second reference to the same run-owned service; this is not a
`core`-specific exception.
None of this pulls in `vscode` or `packages/*`; it's still host-agnostic, just
not self-contained within `core`'s own module boundaries. Don't read the
diagram above as "`flows/` files never import outside `core`."

Files kept at the `core/` root are limited infrastructure helpers or shared
constants, not domain types:

- `constants.ts` — shared preview/threshold constants.

For the process's global state store, take the `AppState` service from
`@platform/interfaces` (`yield* AppState` in Effect code, or thread the store
in from the host's composition root). Workspace-scoped state comes from
`workspaceRoots().workspaceState`.

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
