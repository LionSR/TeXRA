# Harness package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for
`packages/harness` (`@texra-ai/harness`).

## Directory organization

- `packages/harness/src/common/` holds host-neutral, cross-cutting logic with domain meaning (errors, parsing, plugins, storage, teams). Check a module's dependencies before using it from browser code.
- `packages/harness/src/utils/` is host-agnostic, not browser-safe: an import added to a module in the closure of the `./schemas` or `./transcript` entry must stay browser-safe. `utils/core/` has path basics, abort and failure helpers, id minting, and `withPerKeyLane` (`perKeyQueue.ts`).
- `packages/harness/src/platform/` defines the host ports and the process runtime types. Each host's composition root builds one `ManagedRuntime` over `processLayer()` and opens and closes sessions through its `SessionOwner`.
- Hosts and the app hold a session as the public `LocalSession` (`Sessions.open`, `packages/harness/src/effect/sessions.ts`): its view, a run's records (`records(runId)`), the runs this process holds (`held`), the run listing and deletion, and its notices (`emit`), all typed. The internal `SessionHandle` is the harness's; a host never names it.

## Configuration, storage, and workspace files

- **Raw config paths.** Read with `config.get(path)` on the `ConfigProvider` the caller holds (a tool call's `call.roots.config`, a run's or a host command's `session.roots.config`) and write with its `update(...)`. There is no `updateConfig`/`watchConfig` helper and no change-notification API.
- **Catalog settings.** Nearly every `texra.*` path is declared in the settings catalog by its owner: the harness's rows in `packages/harness/src/shared/state/stateSettings.ts` (schemas in `packages/harness/src/shared/schemas/coreSettings.ts`), TeXRA's in `packages/texra/src/shared/settingsView/texraSettings.ts`, and a plugin's in its own settings module, listed in TeXRA's rows. Each config provider carries its catalog (`ConfigProvider.catalog`: TeXRA's hosts pass `TEXRA_SETTINGS`; an embedder uses `nodePlatform({ settings })` from `@texra-ai/harness/node` or `settingsCatalog(rows)` from `@texra-ai/harness/schemas`); there is no process-wide catalog.
  - Read and write catalog paths with `Settings` (`packages/harness/src/shared/config/settings.ts`: `Settings.get(stores, key)`, `.set`, `.reset`), which validates. A row's `onWrite` is data, applied by the writers a person drives (the settings UIs' shared write handler, `sharedSettingsCommands.ts`, and the CLI `/config` form, `CliConfigForm.tsx`), never by `Settings.set`. `stores` are the settings slots the caller holds (a `WorkspaceRoots` is a `SettingsStores`); there is no ambient reader.
  - A `configTarget: 'global'` row is read from global scope only. The exception is `texra.telemetry.enabled`, read from the merged config, where `projectValueIgnored` (`jsonConfigProvider.ts`, from the row's `projectMayOptOut`) lets a project opt out but never in.
  - A write reachable from a settings UI (extension/desktop `UPDATE_STATE_SETTING`, CLI `/config`) goes through `applyStateSettingUpdate` (`packages/texra/src/shared/settingsView/handlers/stateSettingWrite.ts`), which adds the open-workspace guard and the approval-policy side effect.
- **Files.** Inside Effect, use the rooted services (`WorkspaceFs`, `StorageFs`, `GlobalStorageFs` in `@platform/rootedFs`), which refuse a path escaping their root. Workspace path math is pure in the root (`@utils/files/workspaceFS`); outside Effect, every run-storage helper in `@utils/files/runStorageFs` takes the root as its first parameter. Nothing in `@utils/files` resolves a root on its own.
- Pasted images: names from `@texra/utils/files/pastedImageName`, paths from `@texra/utils/files/pastedImageUtils` (keeps Node filesystem code out of browser bundles).
- Discover files with `listWorkspaceFiles` (`packages/texra/src/common/files/workspaceFileListing.ts`) and agents with `AgentCatalog`; don't duplicate discovery.

## Agent execution

- An agent is one definition format (`AgentDefinitionSchema` in `@shared/schemas`, a YAML file or an SDK inline persona) launched with an `AgentConfig` (`packages/harness/src/agent/core/definition/`).
- Launch with `session.runs.launch({ request, options })` (`packages/harness/src/agent/runtime/runRegistry.ts`): it assigns the `runId` and registers the run, and needs the root's `SessionOwner`, so no tool reaches it. A persisted run resumes through `resumeRun` (`resumeToolUseFromResumeData`). Call `executeAgent` only when you own the `runId` (subagent dispatch, `packages/harness/src/tools/delegation/inBandSubagentRun.ts`). Attach presentation and approval behavior to `SessionHandle.interactions`.
- A new provider is a protocol case in `packages/llm` plus its route and credential in `packages/harness/src/agent/runtime/modelAccess/`; there is no per-provider handler class. The `helperModel` path binds through the same route. Register capabilities and pricing in `packages/harness/src/model/computeModelOptions.ts`.

## Run loop architecture

A run is one Effect program in `packages/harness/src/agent/runtime/loop/`, with no cursor and no graph:

- **One program**: `runToolUse` (`loop/toolUse.ts`, `loop/toolUseDispatch.ts`). A task (an agent carrying a plugin's block, `AgentBlock`) runs it on its plugin's recipe script (`script.kind: 'recipe'`); the harness reads nothing inside the block. `loop/rows.ts` builds every draft the loop appends; `core/tools/toolCallParsing.ts` parses tool calls.
- **State is row data.** The loop holds no copy of the conversation: it continues from the `RunState` (`packages/harness/src/shared/session/runState.ts`) that `RunCell.append` (`shared/session/runHistory.ts`) returns, so live and resume are one function.
- **Services come from context**, provided once at the `executeAgent` boundary: `AgentRun` (`runtime/run/AgentRun.ts`), `ModelInvoker` (the only caller of the `packages/llm` `Model`), and the session's `RunHistory` and `Runs`. No services bag.
- **A run's input queue is its own.** A conversation run opens its follow-up reader in its own scope (`claimFollowUps`, `runtime/FollowUps.ts`). A child runs in its parent's tool-call fiber, so a queue taken from context would be the parent's.
- **Write points are the contract**: a `model.message attempt` before a billed request leaves the process; the `response` row before any tool dispatches; `tool.intent` as each call's body starts (after hooks, guard and approval); `tool.result` before the loop continues; a `run.position` for every wait and halt. Every fact the loop branches on is a row field the run state reads; no row restates loop state.
- **One retry loop**, `runInvocation` (`run/invocation.ts`), for every model call. `nextAttempt` (`shared/session/inFlight.ts`) decides from the invocation's rows: each failed attempt commits a `failed` row naming what follows (`retry`, `unchain`, `ask`, `stop`, `cancel`). Automatic resends run under the process's `ModelRetryGate` within a budget counted from the rows, so a crash does not refill it; past it, the `failed` row opens a retry request and the person's `request.decided` starts the next attempt. An approved attempt with no recorded outcome is asked about again, never resent. Provider SDK retries stay disabled. A compaction summary records its attempts (`purpose: 'summary'`); a helper call records none.
- **Interruption is the fiber's.** A durable append is uninterruptible; there is no `AbortSignal` threading inside the loop.
- **Lifecycle**: `executeAgent` / `AgentRunLifecycle` handle init and finalize; the loop only executes.

## Event channels and cards

- Facts a run's trace emits extend `AgentEvent` and reach the session log through `runEventDraft` and the log's `publish`. Facts the session authors (lifecycle, status, approvals) extend `SessionEvent` (`packages/harness/src/shared/schemas/sessionEvent.ts`) and commit through the log's `transact` (`SessionLog`, `packages/harness/src/agent/runtime/SessionHandle.ts`). No `bus.emit` from a VS Code-free zone and no new subscribe surface (`.agents/docs/implemented/architecture/2026-06-10-error-pipeline-and-ownership.md`); `emitAppSignal(...)` stays within its documented scope.
- **One publisher.** Every write to a session's event table is a job on the `SessionEvents` inbox (`transact`, `detach`, `removeRun`, `drain`); commit order is enqueue order.
- **The run loop owns tool cards.** A slow tool's `tool.start` commits with the row that accepts the attempt; a fast tool's card opens and closes in the batch that records its result. With a run history, the card stores no output: it is projected from the `tool.result`. What a tool prints while running is transient text on the card id (`hooks.onToolOutput` → `stream.chunk`), never a row. No tool-side start card, durable progress row, or second append path.

## Storage format

`storeSchema.ts` (`packages/harness/src/controllers/session/`) stamps every `texra.db` with its schema version, moves a pre-1.0 store aside whole at open (`texra.db.pre1`, never read again, settings included) and refuses a newer schema. Row kinds carry their own versions (`packages/harness/src/shared/schemas/rowVersions.ts`), read only by the row codec (`rowCodec.ts`). Before 1.0 a kind changes with no upcaster; bump its version when an older build's row would read wrong, so that row reads as an earlier build's (`DatabaseRowEarlier`) and never as damaged or silently stripped.

## Core quality

In the harness and llm cores (`CORE_QUALITY_DIRS` in `eslint.config.mjs`), `npm run check:core-quality` holds the per-file rules in `RULES` (`scripts/core-quality-measure.mjs`) shrink-only: `!`, `as` without a `// cast:` reason, untyped or undocumented exports, files over 400 lines, functions over 150 lines or complexity 15 or depth 4, silent fallbacks, pass-through and shallow modules, `vi.mock` of a core module, ranged core dependencies, and more. The three depth rules (pass-through, shallow modules, wide records) also hold over every other package's source as `*-outside-core` rows. `any`, `new Promise`, `.then(` and a stray `Effect.run*` are ESLint errors over the same dirs instead, with no disable comment honored. Baselines live in `config/ratchets/core-quality/`, except for the rules in `ZERO_RULES` (`scripts/ratchet-zero-rules.mjs`: import cycles, try/catch around Effect code, the durable invariants), which have no file and fail any site. A rising value fails, and a falling one is lowered with `--update` in the same change (`--move old=new` for a rename); a file-size cap moves only when the file's length rounded up to 25 lines falls below it. `--update` also regenerates `config/api-reports/` and the API reference in `packages/{harness,llm}/docs/api/`, so a public-surface or TSDoc edit needs it too.

## Tool input schemas

The nullable-optional rule is in root `AGENTS.md` "Effect Schema Patterns".

- **Union branches tolerate the other branches' keys.** Provider conversion flattens a top-level union into one object with every branch's properties and no `additionalProperties`, so OpenAI-compatible providers fill other commands' fields with `null`. A `Schema.Struct` ignores undeclared keys, so each branch still enforces its own; never add a check that rejects unknown keys to a branch.
- A union-branch field with a default uses `nullishWithDefault` (`packages/harness/src/tools/core/inputSchema.ts`): `withDecodingDefault` alone lets an explicit `null` through.
- **Design for the model's first call.** A parameter with an obvious default is optional, with the default applied at dispatch; a required parameter models routinely omit is a tool bug. When a description enumerates dispatch behavior, keep it in step with the dispatch table.
