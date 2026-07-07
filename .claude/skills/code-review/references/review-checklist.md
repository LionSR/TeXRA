# TeXRA Review Checklist

Targeted greps + concrete fixes. Pair with the design rules in `CLAUDE.md` (Zod, Flattening Abstraction Layers, Discouraged Factory Patterns, Render-Time Workarounds, Separation of Concerns) — don't restate those; consult them when the diff lands in their territory.

## 1. Platform decoupling (highest-signal)

The full zone list lives in `CLAUDE.md` → "Separation of Concerns: VS Code Coupling". Run these greps on the diff:

- **`grep -nE "from ['\"]vscode['\"]"`** in `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, or any webview `frontend/`. Any hit is a finding.
- **Direct `vscode.workspace.getConfiguration` / `workspace.fs` / `secrets`** in agnostic code → use `platform().config`, `platform().fs`, `platform().secrets` (see `src/platform/platform.ts`). Note: `@utils/config` is the VS Code-allowed wrapper; agnostic code goes through `platform()`.
- **`instanceof vscode.FileSystemError`** → `isFileNotFoundError(err)` from `@common/errors`.
- **`vscode.FileType.File` / `.Directory`** → `isFile()` / `isDirectory()` from `@utils/files/fsEntryType`.
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
- **The same action exposed from two UI surfaces** → one home per action. Flag an `*Events.<name>(` creator dispatched from 2+ components, the same config/state/message key edited in 2+ tabs or views, or multiple UI controls wired to the same command/effect. Secondary surfaces show **read-only status**, not a second control. Legit: global default vs per-item override; a command plus a single UI button for one stable action. See `CLAUDE.md` → "Duplicate UI Controls".

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

## 12. Modern TypeScript (ES2023)

Full pattern list with examples in `AGENTS.md` → "ES2023+ Patterns". Greps for the diff:

- **Bare Node builtin imports** — `grep -nE "from '(assert|buffer|child_process|crypto|events|fs|fs/promises|module|os|path|url|util)'"` → use the `node:` prefix (`from 'node:path'`). The whole repo is unified on it.
- **`[...arr].sort(` / `.slice().sort(`** on a true array → `.toSorted()`. Keep the spread when copying out of a `Set` or `Map.entries()`.
- **`for (let i = 0; i < arr.length; i++)`** where the body only reads `arr[i]` → `for...of` (with `.entries()` when the index is needed). The conversion usually deletes `!` assertions and `if (!item) continue` guards too — flag those leftovers.
- **Backwards index loops** (`for (let i = arr.length - 1; i >= 0; i--)`) that search or visit in reverse → `.findLast()` / `.findLastIndex()` / iterate `.toReversed()`.
- **Manual pairwise-equality loops** over two arrays → `a.length === b.length && a.every((x, i) => ...)`.
- **`.substring(`** → `.slice()` (repo is unified on `slice`).
- **Bare `parseInt(` / `parseFloat(`** → `Number.parseInt(x, 10)` / `Number.parseFloat(x)`; flag any missing radix.
- **`new Promise((resolve) => setTimeout(resolve, ms))`** in Node-only code → `setTimeout` from `node:timers/promises`.
- **Don't flag** the legitimate index loops: token consumers that advance `i` by variable strides, queue/BFS loops that append mid-iteration, and `charCodeAt(i)` hash loops (code-point iteration would change persisted hash output).

## 13. Abstraction-cost guardrails (2026-07 calibration)

Standing rules from the 2026-07 tech-debt re-calibration, which found that a run of "reduction" PRs quietly re-accumulated abstraction cost: 22 PRs pitched as reductions netted **+5,046 production LoC**, with 18 of 22 net-positive — the "Refactor-LOC lesson" at scale. Evidence base: [`docs/proposals/tech-debt-audit-2026-07.md`](../../../../docs/proposals/tech-debt-audit-2026-07.md). Apply these whenever a PR adds a port/facade/projector/strategy/template-method, or is titled `refactor:` / `simplify:` / `consolidate` / `dedupe` / `extract`:

- **Build implies delete in the same PR.** A new port/facade/projector/strategy/template-method merges only if it deletes the path it replaces in that same PR. Deferral is allowed only with a ledger row **and** a concrete removal-trigger issue that is a merge-blocker for the next stage.
- **No leapfrogging a migration.** A staged migration may not merge stage N+1 scaffolding while stage N's deletion issue is still open.
- **Net-positive-LOC "reductions" need a reason.** Reject a PR titled `refactor:`/`simplify:`/`consolidate`/`dedupe`/`extract` that grows LoC unless it (a) deletes an old path, (b) collapses to a genuine ≥2-caller helper, or (c) trades LoC for a `CLAUDE.md`-mandated type-safety win (e.g. a discriminated union with `assertNever`). The PR body must state the actual `git diff --stat origin/main` net LoC and justify any positive number.
- **No trivial-identity or single-caller extractions.** Grep the caller count before approving any new shared helper — one caller is not DRY. Extends `CLAUDE.md` → "Discouraged Factory Patterns".
- **Don't reward activity.** A program/migration that opens more follow-up issues than it retires pauses further building until its tail closes.

## 14. Fewer-elements rulings (2026-07-07)

Mirrors [`docs/proposals/fewer-elements-2026-07.md`](../../../../docs/proposals/fewer-elements-2026-07.md) §7 (R1, R5-R8). On conflict, #6951's single-ownership section wins. Correctness and security fixes are exempt from the doc's R3/R4 sequencing rules, never from these checks.

- **No dual-system resting state (R1).** A code-to-code shim/projection/dual-write/alias merges only if its deletion PR is already open and referenced from its #6981 row, or the row carries a calendar date ≤7 days out. Persisted-data read shims (old stream logs, flow records, agent YAML, workspace state) are the exception: age-based #6981 row with a calendar date. Check: the row cites a PR number or a date. No row, or a row with an undated trigger, is a merge blocker. Applies to shims introduced after this section landed; pre-existing event-triggered rows (Stage 5/D1) are governed by their stage gates, and R3's sweep target dates the rest.
- **Churn-class ban (R5).** Reject reflow/reformat of files the PR does not functionally touch (check: files in the diff with only whitespace/formatting hunks). Reject styles/file splits without net element accounting. Single-caller extractions remain banned (§13); #7070 is the canonical violation.
- **Net-element accounting (R6).** A `refactor:`/`simplify:`/`consolidate`/`dedupe`/`extract` PR body must report constructs added vs deleted (files from diffstat; exported symbols via `^[+-]export` over the diff; class/interface/enum declarations likewise) alongside net LoC. Positive element delta without a stated, staged reason is a merge blocker.
- **Test budget (R7).** New test file only when the product module has no existing suite (one suite per module, path-mirrored under `src/test-kernel/`; or one suite per named cross-module scenario, stated in the PR body); otherwise extend. Tests pinning #6981-ledgered scaffolding carry an in-file expiry comment naming the row, and their LoC counts double in the R6 net accounting. ≥4 structurally identical cases use `test.each`.
- **Consumer-grep before emitter deletion (R8).** A PR deleting or re-routing an emit path states the grepped subscriber count for every affected key in its body. Missing count on a deletion PR is a merge blocker (#7398 precedent: a live `bus.on` consumer was severed for 3.5h on main).

## Final pass

- Cut findings not tied to a real `path:line` in the diff.
- Add the **Verified** section that names what you actually opened.
- If the diff is small and clean, say so and explain _what you checked_. "No issues found" alone is never sufficient on this repo.
