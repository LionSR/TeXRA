# Harness package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for
`packages/harness` (`@texra-ai/harness`): its shared directories, configuration
and storage access, agent execution, the run loop, the storage format, the core
quality bar, and tool input schemas.

## Directory organization

- `packages/harness/src/common/` holds host-neutral, cross-cutting logic with domain meaning (errors, files, parsing, storage, constants), not a backend-only zone. Some browser-adjacent shared code imports dependency-light modules such as `@common/parsing/safeParseJson`; import through the `@common/*` alias and check the target's dependencies before using it from browser code.
- `packages/harness/src/utils/` is host-agnostic; only the four `BROWSER_SAFE_UTILS` modules in `eslint.config.mjs` are browser-reachable (CLAUDE.md "Layout"). Helpers specific to one side belong in `frontend/` or `common/`; an import added to one of the four must stay browser-safe.
  - `utils/core/` - Async, type-guard, math, comparator, and path-basics primitives (`debounce`, `filterNotNull`, `clamp`, `byName`, `normalizeFilePath`, `getBasename`, `getFileStem`)
    - `utils/core/perKeyQueue.ts` - `withPerKeyLane`, the one per-key serialization lane (Effect-based; `KeyedMutex` and `async-mutex` were retired by #12696)

- `packages/harness/src/platform/` - Platform abstraction layer: the host ports and the process runtime types. Each host's composition root builds one `ManagedRuntime` over `processLayer()` at startup; agnostic code reads the ports from the Effect context that runtime serves, and the root opens and closes sessions through its `SessionOwner`.
- Retrieve included file extensions via `getIncludedExtensions` in `packages/harness/src/common/files/fileTypeUtils.ts`.

## Configuration, storage, and workspace files

- For a raw config path, read with `config.get(path)` on the `ConfigProvider` the caller holds (a tool call's `call.roots.config`, a run's `session.roots.config`, a host command's `session.roots.config`) and write with that provider's `update(...)`; there is no standalone `updateConfig`/`watchConfig` helper and no change-notification API. Nearly every `texra.*` path is modeled in the Zod catalog, declared by owner: the harness's rows in `packages/harness/src/shared/state/stateSettings.ts` (schemas in `packages/harness/src/shared/schemas/coreSettings.ts`), TeXRA's own in `packages/texra/src/shared/settingsView/texraSettings.ts`, and a plugin's on its `Plugin` value's `settings`; hosts pass TeXRA's rows to `processLayer`, which installs the one catalog; for those, prefer the catalog helpers in `packages/harness/src/utils/config/platformSettings.ts` (`readSettingFrom(stores, key)`, `writeSettingTo(stores, key, value)`) over a raw cast, since they route through the shared validation/`onWrite` path. The `stores` are the settings slots the caller holds (a `WorkspaceRoots` is a `SettingsStores`); there is no ambient reader, so a caller that cannot name its slots has an owner to fix, not a fallback to reach for. Exceptions: the `configTarget: 'global'` rows (the five Models-tab provider toggles, `texra.telemetry.enabled`) keep merged-config semantics on runtime reads and do not go through the catalog reader, which answers a global-target row from global scope only (telemetry's project-file rule, opt out but never in, is the store's `projectValueIgnored` in `jsonConfigProvider.ts`, driven by the row's `projectMayOptOut`); and the CLI's git-author keys (`GIT_MARK_COMMITS`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_WORKTREE_SUPPORT`) go through the CLI's own `readGitAuthorSettingsFromState`, since the catalog helpers default to the `'vscode'` storage slot. For a write reachable from a settings UI (extension/desktop `UPDATE_STATE_SETTING`, CLI `/config`), call `applyStateSettingUpdate` (`packages/texra/src/shared/settingsView/handlers/stateSettingWrite.ts`) rather than `writeSettingTo` directly: it adds the open-workspace guard and the approval-policy side effect a bare catalog write skips.
- Inside Effect, reach a session's files through the rooted services (`WorkspaceFs`, `StorageFs`, `GlobalStorageFs` in `@platform/rootedFs`): each captures its root when its layer is built and refuses a path that escapes it. Workspace path math is a pure function of the root (`workspaceAbsolutePath`/`workspaceRelativePath`/`locateInWorkspace` in `@utils/files/workspaceFS`). Outside Effect, a helper takes the root as data: every run-storage path helper in `@utils/files/runStorageFs` has the root as its first parameter. Nothing in `@utils/files` resolves a root on its own.
- Generate and identify pasted-image filenames with `@utils/files/pastedImageName` and resolve, validate, and persist their paths with `@utils/files/pastedImageUtils` (keeps Node filesystem code out of browser bundles).
- Surface files through the shared listing (`listWorkspaceFilesOfType` in `packages/texra/src/controllers/session/workspaceFileOptions.ts`) and agents through the process catalog (`@agent/index`) instead of duplicating discovery logic.

## Agent execution and tool-use

- An agent is written in the one definition format (`AgentDefinitionSchema` in `@shared/schemas`, a YAML file or an SDK inline persona) and launched with an `AgentConfig` (`packages/harness/src/agent/core/definition/`); compose runs via the factories in `packages/harness/src/agent/runtime`.
- Launch executions via `runAgent` and resume via `resumeRun` (see CLAUDE.md "Agent system"); use the lower-level `executeAgent` only when you already own the `runId` (e.g. subagent dispatch in `packages/harness/src/tools/delegation/inBandSubagentRun.ts`). Attach presentation and approval behavior to the run's `SessionHandle.interactions`.
- A new provider is a protocol arm in `packages/llm` plus its route and credential in model access (`packages/harness/src/agent/runtime/modelAccess/`, the one service a run binds through); there is no per-provider handler class. Register capabilities/pricing in `packages/harness/src/model/computeModelOptions.ts`.

## Run loop architecture

A run is one Effect program in `packages/harness/src/agent/runtime/loop/`, no cursor and no graph:

- **One program**: `runToolUse` (`loop/toolUse.ts`, with `loop/toolUseDispatch.ts`). A document task runs it on the documents plugin's recipe script (`packages/texra/src/agent/output/documentRecipe.ts`), which calls the agent once per revision and handles its output with the document tools (`packages/texra/src/tools/documents/`). `loop/rows.ts` builds every run history draft the loop appends. `core/tools/toolCallParsing.ts` parses the response's tool calls.
- **State is row data.** The loop never holds its own copy of the conversation: it continues from the folded `RunState` (`packages/harness/src/shared/session/runStateFold.ts`) that `RunHistory.appendBatch` returns, so the live path and the resume path are one function. Resume reads only the fold; `flow_<id>.json` is never read.
- **Services come from context**, provided once at the `executeAgent` boundary: `AgentRun` (`runtime/run/AgentRun.ts`, everything one run owns), `ModelInvoker` (the only service that calls the `packages/llm` `Model`), and the session-root `RunHistory` and `Runs` (`runtime/runRegistry.ts`: admission, lanes, live handles, waiting termination; built by the session layer). No services bag, no node fields.
- **A run's input queue is its own, never context.** A conversation run claims its lease over the follow-up queue in its own scope (`claimFollowUps` in `runtime/FollowUps.ts`, from `runToolUse`); a round-mode run takes no input and claims none. A child launched from a parent's tool call runs in that call's fiber, so a context-provided queue would hand it the parent's: never read another run's input from context.
- **Write points are the contract**: a `model.message attempt` before a billed request leaves the process; the `response` row before any tool dispatches; `tool.intent` as each call's body starts (after its hooks, guard and approval, so before it nothing of the attempt ran); `tool.result` before the loop continues; a `run.position` for every wait and every halt. Every fact the loop branches on is a row field the fold reads (a run's model and binding on its `run.config`, its input on the `append` that changes it, a nudge's `reason`); no row restates loop state.
- **One retry loop**, `runInvocation` in `run/invocation.ts`, for every model call. Its next move is `nextAttempt` (`shared/session/inFlight.ts`) over the invocation's rows: each failed attempt commits a `failed` row with the move after it (`retry`, `unchain`, `ask`, `stop`, `cancel`); automatic resends run under the process's `ModelRetryGate` within a budget counted from the rows, so a crash does not refill it; past it, the `failed` row opens a retry request in its own batch and the person's `request.decided` admits the next attempt, which consumes it. An attempt of an invocation a person admitted, whose outcome no row recorded, is asked about again, never resent unasked. Nothing else retries a model call; provider SDK retries stay disabled. A compaction summary records its attempts on the run's history (`purpose: 'summary'`, which the run fold skips); a helper call records none.
- **Interruption is the fiber's.** Each activity/append pair runs under `Effect.uninterruptibleMask` with only the handoff and the durable append masked; there is no `AbortSignal` threading inside the loop.
- **Agent owns lifecycle**: `executeAgent` / `AgentRunLifecycle` handle init and finalize; the loop only executes.

## Storage format

The session database is
the root "Compatibility and format retirement" stance made mechanical: `storeSchema.ts`
(`packages/harness/src/controllers/session/`) stamps every `texra.db` with its schema version
and moves a store written before 1.0 aside whole at open (`texra.db.pre1`,
never read again, settings included) and refuses one of a newer schema. Row
kinds carry their own versions (`packages/harness/src/shared/schemas/rowVersions.ts`), read by
the row codec (`rowCodec.ts`) alone; until the 1.0 release freezes them, every
kind is unreleased and changes with no upcaster and no bump.

## Core quality

- **The core holds the pi bar, shrink-only.** In the harness and llm cores (`CORE_QUALITY_DIRS` in `eslint.config.mjs`), `npm run check:core-quality` holds the sixteen rules of the core-quality study (texra-design-pages `core-quality-study.md` §14) plus a few of its own, per file: `any`, `!`, `as` casts without a `// cast:` reason, object-literal assertions, exported functions without a return type, exports without TSDoc, runtime import cycles, files over 400 lines, functions over 150 physical lines (layer closures included) or modified complexity 15 or depth 4, `new Promise`, `.then(`, `Effect.run*` outside a named entry, try/catch around Effect code, silent fallbacks, exported records over 20 public members, non-erasable syntax, `vi.mock` of a core module, ranged core dependencies, the files and packages each core entry reaches, the numbered durable invariants, and core READMEs without a diagram. Decision codes in comments are measured only. Baselines live in `config/ratchets/core-quality/`; a value that rises fails, and one that falls must be lowered with `--update` in the same change (`--move old=new` carries a rename). `config/api-reports/` holds each core package entry's public surface, regenerated by `--update`, so a surface change shows as a diff. When a hotspot is too complex, find the data structure, duplicated fact or misplaced owner behind it; never split a file mechanically.

## Tool input schemas

Root `AGENTS.md` "Tool input schemas" has the `.nullish()` rule.

**Discriminated-union branches use `.looseObject()`, not `.strictObject()`.** Provider conversion flattens a top-level union into ONE object schema whose properties are the union of every branch's, and it emits no `additionalProperties` key - so the model is never told the flattened object is closed. OpenAI-compatible providers (DeepSeek, Kimi, etc.) then fill every advertised property, including ones that belong to a different command, with `null` rather than omitting it. A `strictObject` branch rejects that as an unrecognized key regardless of nullability; `looseObject` tolerates the cross-branch leakage while still enforcing each branch's own required fields.

A union-branch field with a default needs `nullishWithDefault` (`packages/harness/src/tools/core/inputSchema.ts`) rather than `.prefault()`: `.prefault()` substitutes only for `undefined`, so an explicit `null` fails validation inside the correctly-selected branch, where `looseObject` gives no help.

### Design for the model's first call

Any parameter with an obvious default should be optional with that default applied at dispatch time (`.nullish()` plus a default when the tool runs), not required: a required parameter that models routinely omit is a tool bug, not a model error. When a description string enumerates dispatch behavior, verify it against the actual dispatch table whenever either changes.
