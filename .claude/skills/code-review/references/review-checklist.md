# TeXRA Review Checklist

Targeted greps + concrete fixes. Pair with the design rules in `CLAUDE.md` (Zod, Flattening Abstraction Layers, Discouraged Factory Patterns, Render-Time Workarounds, Separation of Concerns) — don't restate those; consult them when the diff lands in their territory.

## 1. Platform decoupling (highest-signal)

The full zone list lives in `CLAUDE.md` → "Separation of Concerns: VS Code Coupling". Run these greps on the diff:

- **`grep -nE "from ['\"]vscode['\"]"`** in `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, or any webview `frontend/`. Any hit is a finding.
- **Direct `vscode.workspace.getConfiguration` / `workspace.fs` / `secrets`** in agnostic code → use `platform().config`, `platform().fs`, `platform().secrets` (see `src/platform/platform.ts`). Note: `@utils/config` is the VS Code-allowed wrapper; agnostic code goes through `platform()`.
- **`instanceof vscode.FileSystemError`** → `isFileNotFoundError(err)` from `@common/errors`.
- **`vscode.FileType.File` / `.Directory`** → `isFile()` / `isDirectory()` from `@common/files/fsEntryType`.
- **`vscode.window.show*Message()` in business logic** → return error results; let the command/frontend layer handle UI.
- **`process.env`, `os.homedir()`, raw `fs/promises`, `child_process.exec`** in agnostic zones → platform interfaces or `executeCommand` from `@utils/system/execUtils`.
- **`initPlatform()`** called outside the host entry point (`packages/extension/src/extension.ts`) → bug. Read access uses `platform()`; module-init facades use `tryPlatform()`.

## 2. Zod v4 schema correctness

Design rules in `CLAUDE.md` → "Schema and Type Guidelines" / "Backward Compatibility with Zod" and `AGENTS.md` → "Zod v4 Schema Patterns". Greps for the diff:

- **Tool input schemas using `.optional()`** instead of `.nullish()` (breaks DeepSeek/Kimi/etc. structured output). At use sites, check for `=== undefined` (should be `== null`).
- **Verbose old-style types**: `.string().int()`, `.string().uuid()`, `.string().datetime()`, `.nativeEnum`, `.passthrough()` → `.int()`, `.uuid()`, `.iso.datetime()`, `.enum()`, `.looseObject()`.
- **Manual `safeParse` + ternary for defaults** → `Schema.catch(default).parse(data)`.
- **`z.custom<T>()` without a comment** justifying why a real schema isn't possible.
- **`.prefault` vs `.default` vs `.catch`** misuse: `.prefault` normalizes input _before_ validation (deserialization); `.default` fills in _after_ a missing field; `.catch` recovers from validation throws. Wrong choice silently corrupts state.

## 3. PocketFlow / agent runtime

- **`return 'continue' | 'finalize' | 'complete' | 'default'`** → use `FlowTransition.CONTINUE`/`FINALIZE`/`COMPLETE`/`DEFAULT` from `@agent/core/flows/FlowTransitions`.
- **Mutable services**: anything passed to `flow.setServices()` that gets reassigned mid-run belongs in the shared store, not services.
- **Lifecycle leak**: agent init/finalize logic appearing inside flows or nodes. Agents own lifecycle; flows execute; nodes throw and let `agent.run()` catch.
- **`prep` / `exec` / `post` boundaries**: state mutations belong in `post`, not `exec`. Retries via `maxRetries` / `retryDelay` getters, not ad-hoc loops.
- **Plain `console.log` or untagged `logger.info` in agent flows** → wrap with `AgentLogger` (`@logger`, exported from `src/logger/index.ts`) for grouped, tool-use-aware channels.
- **Log payloads built by string interpolation** (file lists, missing outputs, latexdiff results, usage stats) → pass via the structured `data` argument so the progress view can render them.
- **Commands invoking flow factories directly** → must launch via `executeAgent` (`src/agent/runtime/executeAgent.ts`) so session filters and resume actions stay coherent.

## 4. Configuration, storage, files

- **Inline config strings** sprinkled across modules → use the typed accessors (`platform().config` in agnostic code; `getConfig`/`watchConfig` from `@utils/config` in VS Code-allowed code) so `watchConfig` can react. Verify keys exist in `package.json`'s `contributes.configuration`.
- **Manual workspace path joining** → `WorkspaceFS.getPath()` and the helpers in `@utils/files`.
- **Pasted-image paths** generated/resolved manually → `pastedImageUtils`.
- **Long-running writers without retention** → `RelativeFS.cleanupOldFiles` (or equivalent).

## 5. Webview / render-time

`CLAUDE.md` → "Render-Time Workarounds" already lists the anti-patterns. Greps for the diff:

- **`Date.now()` or synthetic IDs inside render functions** → move ID/timestamp creation to the producer.
- **Lit components mutating shared state** → dispatch events; let the manager handle (`StreamTabs`, `LogList`, `OutputFilesManager`, `WebviewUpdater`, `UsageStatsManager`).
- **Direct DOM manipulation alongside Lit components** → extend the existing component instead.
- **Webview providers/handlers not extending `BaseViewContentProvider` / `BaseViewMessageHandler`** (`src/common/webview/`).
- **String literals for webview commands** → constants in `src/common/webview/commands.ts`.
- **New shared module path referenced without updating `localResourceRoots`** → 401 at runtime.

## 6. Error handling and logging

- **Ad-hoc `vscode.window.showErrorMessage`** → `logErrorMessage` / `showLoggedErrorMessage` / `showLoggedMessageWithDocs` from `@common/errors/errorHandlingUtils`.
- **Swallowed errors** (`catch {}` / `catch (_) {}`) without a comment explaining why.
- **`instanceof Error`** narrowing where the standard helpers above apply.

## 7. Bash, exec, and security

- **`child_process.exec` direct calls** → `executeCommand` from `@utils/system/execUtils`.
- **String-interpolated shell commands** → arg arrays; flag command-injection risk on any user/LLM-derived data.
- **`path.join(workspaceRoot, userInput)`** without canonicalization → path-traversal risk; use `WorkspaceFS` / `RelativeFS`. Workspace contents are LLM-influenced; treat as untrusted.

## 8. Build, lint, dead code

- **`npm test` invocations** added anywhere (scripts, CI, docs) → must not exist; downloads VS Code test env.
- **Type-sensitive changes without mention of `npm run typecheck` / `compile:safe`** → `compile:fast`/`package:fast`/`build:fast` skip type checks.
- **Long relative imports** (`../../../../`) where a path alias exists.
- **Re-export shims** for renamed/removed code, "// removed" comments, `_unused` placeholder vars — delete cleanly per `CLAUDE.md` Flattening rules.
- **Dead exports** (declared, no consumer). `grep -r "exportedSymbol" src/`.

## 9. Comments

- **WHAT comments** on well-named code → delete.
- **Process tags** ("// added for issue #123", "// per Codex review") → belong in PR description; delete from code.
- **Multi-paragraph docstrings on private helpers** → one short line max.

## 10. Concurrency and resources

- **Shared mutable state held across `await`** → race risk; capture locals before `await`.
- **Webview disposes that don't unregister listeners / FS watchers** → leak.
- **Long-running model handlers / tool calls without `signal.aborted` checks** between awaits.

## 11. Common backward-compat traps

- **Settings migrating from `package.json` config to storage** → schema must be `z.union([NewSchema, LegacyConfigSchema.transform(...)])` so the legacy shape still loads during the migration window.
- **Renamed fields in persisted state** (`TaskState`, run records, session storage) → use `.prefault()` and tolerate the old shape (canonical pattern in `c9f8b2b`).
- **Provider-handler `switch` over a discriminated union** → default branch should `assertNever` / `satisfies never` so adding a provider compile-fails.

## Final pass

- Cut findings not tied to a real `path:line` in the diff.
- Add the **Verified** section that names what you actually opened.
- If the diff is small and clean, say so and explain _what you checked_. "No issues found" alone is never sufficient on this repo.
