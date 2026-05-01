# TeXRA Review Checklist

Targeted checks for this repo. Anchored in CLAUDE.md and AGENTS.md. Use the categories that match the diff — don't grind through the whole list.

## 1. Platform decoupling (highest-signal category)

Search the diff for the patterns below.

- **Forbidden `vscode` imports.** `grep -nE "from ['\"]vscode['\"]"` in: `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, and any `**/frontend/` webview directory. Any hit is a finding — point to the corresponding `@platform` facade or `@common/files/fsEntryType` helper.
- **Direct `vscode.workspace.getConfiguration` / `workspace.fs` calls** in agnostic code. Replace with `getConfig` / `updateConfig` / `watchConfig` from `@utils/config` and `WorkspaceFS` / `RelativeFS` / `StorageFS` / `GlobalStorageFS` / `AbsoluteFS` from `@utils/files`.
- **`instanceof vscode.FileSystemError`** — should be `isFileNotFoundError(err)` from `@common/errors`.
- **`vscode.FileType.File` / `Directory`** — should be `isFile()` / `isDirectory()` from `@common/files/fsEntryType`.
- **`vscode.window.show*Message()` inside business logic.** Push UI side effects to the command/frontend layer. Business logic returns error results.
- **Composition root abuses.** `initPlatform()` should only be called from the host entry point (`src/extension.ts` or future CLI/Electron host). `platform()` is for read access. `tryPlatform()` is reserved for module-init facades.
- **Bypassing the platform.** `process.env`, `os.homedir()`, raw `fs/promises`, `child_process.exec` in agnostic zones — should go through the platform interfaces or `executeCommand` from `@utils/system/execUtils`.

## 2. Zod v4 schema correctness

- **Tool input schemas use `.optional()`** instead of `.nullish()`. Breaks OpenAI-compatible structured output (DeepSeek, Kimi, etc.). Always `.nullish()` on optional fields, and use `== null` (not `=== undefined`) at use sites.
- **Verbose old-style types**: `.string().int()`, `.string().uuid()`, `.string().datetime()`, `.nativeEnum(...)`, `.object({...}).passthrough()`. Should be `.int()`, `.uuid()`, `.iso.datetime()`, `.enum(...)`, `.looseObject({...})`.
- **`z.custom<T>()`** when a real schema exists. Prefer `z.discriminatedUnion()` for unions; `z.custom` is a last resort and needs a comment justifying it.
- **Duplicated field definitions** across schemas instead of `.extend()` / `.pick()` / `.partial()`.
- **Manual `safeParse` + ternary** to provide a default — should be `Schema.catch(default).parse(data)`.
- **Backward-compat handled via scattered `if`s** in consumers — should be a single `z.union([NewFormat, LegacyFormat.transform(...)])` at the entry point producing one canonical shape.
- **Default value confusion**: `.prefault(v)` for normalizing inputs *before* validation (deserialization); `.default(v)` for *after* validation succeeds with missing field; `.catch(v)` for validation throw. Wrong choice silently corrupts state.
- **Compile-time sync**: when a schema must mirror an external SDK type, a `satisfies` assertion should pin them together.

## 3. PocketFlow / agent runtime

- **Mutable services.** `flow.setServices()` payload should be frozen-by-convention. Any field that gets reassigned during a run belongs in the shared store, not services.
- **Magic transition strings**. `return 'continue'` / `'finalize'` / `'complete'` / `'default'` should use `FlowTransition.CONTINUE` / `FINALIZE` / `COMPLETE` / `DEFAULT`.
- **Lifecycle leak**: flows or nodes calling agent init/finalize work. Agents own lifecycle; flows handle execution; nodes throw and let `agent.run()` catch.
- **Wrapper-only files**. Anything whose only job is `createState() → flow.run() → interpret result` should be inlined into the calling node. CLAUDE.md cites `ResponseCycle.ts` / `ToolUseCycle.ts` as past offenders.
- **`prep`/`exec`/`post` boundaries**: state mutations belong in `post`, not `exec`. Retry config goes through `maxRetries` / `retryDelay` getters, not ad-hoc loops.
- **Missing `AgentLogger`**: agent flows should wrap `@logger/logUtils` with `AgentLogger` for grouped, tool-use-aware channels. Plain `console.log` or untagged `logger.info` is a finding.
- **Unstructured log payloads**: file lists, missing outputs, latexdiff results, usage stats should go through the `data` argument, not interpolated into the message string. The progress view depends on structured payloads.

## 4. Configuration, storage, files

- **Config strings sprinkled inline.** Settings reads should funnel through `getConfig` from `@utils/config` so `watchConfig` can react to changes. Keys should match what's declared in `package.json`'s `contributes.configuration`.
- **Direct path joins on workspace files**. Use `WorkspaceFS.getPath()` and friends; don't reach into `vscode.workspace.workspaceFolders` from agnostic code.
- **Pasted-image paths** generated/resolved manually instead of via `pastedImageUtils`.
- **Cleanup**: long-running data writers should use `RelativeFS.cleanupOldFiles` (or equivalent) rather than rolling their own retention.
- **Session/run directories**: agents must launch via `executeAgent` (`src/agent/runtime/executeAgent.ts`) so session filters and resume actions stay coherent. Direct calls into flow factories from commands skip that wiring.

## 5. Factory and abstraction layering

- **Two-layer factories called once**: `createX → buildY` where `buildY` has one caller. Inline.
- **Trivial identity factories**: `createOptions(o) { return { ...o }; }`. Use the literal.
- **Re-export shims** for renamed/removed code (`export * from './X.removed'`, "// removed" comments, `_unused` placeholder vars). CLAUDE.md says: delete cleanly, don't leave breadcrumbs.
- **Dead wrappers**: function calls only one underlying call and adds no logic. Inline at the call site if there's only one consumer.

## 6. Render-time workarounds (webviews)

- **`Date.now()` / synthetic IDs in render functions.** Move ID/timestamp creation to the producer.
- **DOM queries to check whether data exists** before rendering. Means upstream data is incomplete.
- **Deduplication after rendering** (comparing rendered HTML or text). Means the data path isn't deduped.
- **Lit components mutating shared state** instead of dispatching events the manager handles.
- **Direct DOM manipulation alongside Lit components**: prefer extending the existing component or manager (`StreamTabs`, `LogList`, `UsagePanel`, `OutputFilesManager`, `WebviewUpdater`, `UsageStatsManager`).

## 7. Webview consistency

- **Provider/handler not extending base classes**: every webview should extend `BaseViewContentProvider` and `BaseViewMessageHandler` from `src/common/webview/`.
- **String literals for webview commands**: use the constants in `src/common/webview/commands.ts`.
- **Missing `localResourceRoots`** entries when a new shared module path is referenced — causes 401s at runtime.
- **Naming**: `[Domain]View[Component]` (`MainViewContentProvider`, `SettingsViewMessageHandler`).
- **CSS sprawl**: per-component styles should live as TypeScript in each view's `frontend/`, with shared tokens in `src/common/styles/common.css`.
- **CDN vs local**: complex deps (markdown-it, KaTeX, highlight.js) should be CDN-loaded; lightweight bundles (split.js, codicons) local.

## 8. Error handling and logging

- **Ad-hoc `vscode.window.showErrorMessage`** instead of `logErrorMessage` / `showLoggedErrorMessage` / `showLoggedMessageWithDocs` from `@common/errors/errorHandlingUtils.ts`.
- **Swallowed errors** (`catch {}` or `catch (_) {}`) without comment explaining why.
- **Silent failure paths**: returning `undefined` / `null` on error without logging at the right level. Routine events use debug; outcomes use info/error.
- **Error type narrowing**: `instanceof Error` checks instead of repo-standard helpers.

## 9. Naming and style

- Service singletons that hold state and behavior: **PascalCase** (`StreamStatusService`, `ModelRegistry`).
- Simple command/function namespaces: **camelCase** (`agentCommands`, `latexCommands`).
- True constants: **UPPER_SNAKE_CASE** (`MAX_ERROR_LENGTH`).
- Long relative imports (`../../../../`) where a path alias exists.
- Dead exports (declared, no consumer). `grep -r "exportedSymbol" src/` to verify.

## 10. Bash, exec, and security

- **`bash` / `child_process.exec` direct calls** instead of `executeCommand` from `@utils/system/execUtils`.
- **Unescaped interpolation** in shell strings — command injection risk. Prefer arg arrays.
- **Path traversal**: workspace-relative paths should pass through `WorkspaceFS` / `RelativeFS`, never raw `path.join(workspaceRoot, userInput)` without canonicalization.
- **Untrusted workspaces**: TeXRA disables them in `package.json`. Code should still treat workspace contents as untrusted input (LLM-influenced data).

## 11. Build, test, lint hygiene

- **`npm test` invocations** in scripts, CI, or docs — must be removed. Use `npm run typecheck` and `npm run lint`.
- **Build script picks**: a PR adding type-sensitive code should mention running `npm run typecheck` or `compile:safe`. esbuild/vite paths skip type checks.
- **Lint must pass** before commit. Don't commit through lint failures.

## 12. Comments and changelog

- **WHAT comments** on well-named code ("// store the user list"). Delete.
- **Process tags** ("// added for issue #123", "// per Codex review"). Move to PR description; delete from code.
- **Multi-paragraph docstrings** in private helpers. One short line max for non-public helpers.
- **CHANGELOG.md churn**: only user-visible changes; never document intermediate bugs fixed within the same PR. Group as Features / Bug Fixes / Improvements.

## 13. Concurrency and resources

- **Shared mutable state across `await`** boundaries — race risk. Capture locals before `await`.
- **Listener / watcher leaks**: webview disposes should unregister event listeners and FS watchers.
- **`AbortController`** signals: long-running model handlers and tool calls should respect cancellation; check for `signal.aborted` after each `await`.
- **`FollowUpQueue` / `ToolUseFollowUpQueueManager`**: queue semantics changed recently — verify ordering and cancellation interactions if touched.

## 14. Common backward-compat traps

- **Migrating settings to storage**: when a setting moves from `package.json` config to storage, both must read fall back to the legacy config until the migration window closes. Schema should be `z.union([NewSchema, LegacyConfigSchema.transform(...)])`.
- **Renamed fields in persisted state**: persisted `TaskState`, run records, and session storage must `prefault` missing fields and tolerate the old shape — see `c9f8b2b` (validate persisted TaskState) for the canonical pattern.
- **Provider handler exhaustiveness**: switches over provider unions should compile-fail when a new provider is added; check for `assertNever` / `satisfies never` on the default branch.

## Final pass

- Re-read your findings list. Cut anything not tied to a real file:line in the diff.
- Add the **Verified** section that names what you actually opened.
- If the diff is small and clean, say so and explain *what you checked*. "No issues found" alone is never a sufficient review on this repo.
