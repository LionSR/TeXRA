# PRD: TeXRA CLI

**Status:** Draft (v1 — grounded in codebase scout + ecosystem survey, May 2026)
**Owner:** TBD
**Date:** 2026-05-03
**Branch:** `claude/texra-cli-electron-prd-AXNBu`
**Companion to:** [`prd-electron-app.md`](./prd-electron-app.md)

## 1. Summary

Ship TeXRA as a third host — `texra`, a stand-alone command-line tool — alongside the VS Code extension and the planned Electron desktop app. The CLI runs the same agent core that the other two hosts run, with two consumption modes:

1. **Headless / batch mode** (`texra run …`, `--print`, `--output-format json`) — non-interactive, exit-code-driven, suitable for shell pipelines, GitHub Actions, dev containers, and any CI/CD environment that just wants `input.tex → output.tex` (or a tool-use agent run with pre-approved tool calls).
2. **Interactive mode** (`texra` with no args, or `texra chat`) — Codex-CLI / Claude-Code-style terminal UI for orchestrator and other tool-use agents, with TTY-aware prompts for edit / bash / plan approvals.

Both modes import `@texra/core` unchanged. The CLI shell is pure Node, ESM-first, with no `vscode` and no `electron` dependency. No webviews are needed. Net-new code lives in a fourth pnpm workspace at `packages/cli/`.

Per a parallel scout of the runtime, almost every blocker the Electron PRD's §9 Tier 1 identified for the desktop port has already landed (see §4.1 for the audit). The CLI's runtime cost is therefore _not_ "extract a kernel from VS Code coupling" — that work is paid for. The CLI cost is "wire the (already-clean) kernel to a Node entry point, a TTY renderer, an approval policy engine, and a small auth flow."

The agent core ships with Node-friendly platform defaults already explicitly tagged "for CLI / Electron / tests" (`consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets`). Of the 6 default impls in `src/platform/defaults/`, the CLI **reuses 5 byte-for-byte** and replaces `EnvSecrets` with a keyring-backed adapter so personal API keys and OAuth tokens persist across invocations; it also adds a file-backed `ConfigProvider` adapter (~180 LOC combined). The CLI is fundamentally a thin Node shell over an already-headless kernel.

(Throughout this PRD, `@texra/core` references the kernel package created by the Electron PRD's Phase 0 monorepo split — the kernel currently lives in `src/`. CLI Phase 0 inherits the split or ships against `src/` aliases unchanged; the import surface is identical.)

## 2. Goals

- Run **workflow agents** (correct, polish, elevate, devise, criticize, merge, OCR, transcribe, …) fully headless from a terminal or GitHub container. `input.tex → output.tex` in one command, exit code reflects success.
- Run **tool-use agents** (orchestrator, devise, search, generic chat) headless when possible (with explicit tool-approval policy) or in an interactive TUI when the user wants the orchestrator-driven research loop.
- Ship a **`texra-action` GitHub Action** that wraps the CLI for `pull_request`/`workflow_dispatch` triggers — repos can run `polish` on a `.tex` PR, or `verifyFix` after a build failure, with no local install.
- Reuse `@texra/core` byte-for-byte. No fork of agent logic, no parallel YAML loader, no parallel model handlers, no parallel approval logic. The CLI is a fourth thin shell, not a parallel implementation.
- Single distribution path: `npm install -g @texra/cli` (or `pnpm dlx @texra/cli`). Runs on Node 20+ on Linux / macOS / Windows, plus all major Linux containers (Debian, Alpine, Ubuntu).
- First-class CI support: `--output-format json`, `--print`, `--approval-policy never`, `--allowed-tools …`, structured stderr, deterministic exit codes.
- Auth model that works on both an SSH session and a graphical laptop: env-var (`TEXRA_API_KEY`) + OAuth loopback + OAuth device-code, in that priority order. No reliance on a desktop browser session for CI.

## 3. Non-goals

- **Not** a port of the three Lit webviews to the terminal. The settings dashboard is configuration-as-code (YAML/env), not a TUI form. The progress webview's rich diff/markdown/log surfaces are replaced by a streaming text renderer; we don't try to recreate them in Ink at v1.
- **Not** a Monaco-grade in-terminal diff viewer. CLI diff approval shows a unified textual diff; users wanting side-by-side go to the desktop app or `git difftool`.
- **Not** a long-running daemon, server, or socket-IPC orchestrator at v1. Each `texra` invocation is a fresh process. (`texra serve` for an HTTP/JSON-RPC server is §18.1 future work.)
- **Not** a TUI rewrite of every existing extension command. v1 ships **agent execution, agent listing, model listing, login/logout, config get/set**, and the `texra-action` integration. The remaining ~50 commands stay extension-only until demand surfaces.
- **No new agent features.** The CLI is purely a host change. Any agent capability the CLI ships also exists in the extension, and vice versa.

## 4. Background

### 4.1 Why this is tractable — measured

A six-front parallel scout of the agent runtime, platform abstractions, tools, approvals, auth, and ecosystem patterns produced a sharp result: **most of the work the Electron PRD describes as pre-refactoring is already merged**. The CLI inherits that work for free.

| Concern                                                                          | Status today                                                                                                                                                                                                                                                                                                                                                                                                                      | CLI impact                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentRuntimeHost` / `ProgressSink` boundary (Electron PRD §9 #20)               | **Landed.** `executeAgent()` accepts an optional `runtimeHost` on `ExecuteAgentOptions`; resolution uses `AsyncLocalStorage` (`runWithAgentRuntimeHost`) with a process-global default fallback. No `ProgressEventBus` singleton import in agent code.                                                                                                                                                                            | CLI calls `setDefaultAgentRuntimeHost()` once at startup with its own `ProgressSink` (writes to stdout / stderr / JSON stream). ~80 LOC.                                                                                                                                                                                                                                                                                   |
| Expanded `ConfigProvider` (`update`/`inspect`/`isExplicitlySet`/`watch`) (§9 #1) | **Landed.** All four methods on `src/platform/interfaces/config.ts`.                                                                                                                                                                                                                                                                                                                                                              | CLI implements `ConfConfigProvider` against `conf` (or a layered YAML reader). ~100–120 LOC.                                                                                                                                                                                                                                                                                                                               |
| `WorkspaceProvider.watch()` (§9 #4)                                              | **Landed.** `nodeWorkspace` already implements `watch()` with recursive `fs.watch` + fallback.                                                                                                                                                                                                                                                                                                                                    | Reused as-is. CLI batch mode never calls `watch()`; interactive mode does.                                                                                                                                                                                                                                                                                                                                                 |
| `vscode.EventEmitter` → Node `EventEmitter` (§9 #3)                              | **Landed.**                                                                                                                                                                                                                                                                                                                                                                                                                       | No CLI work.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SupabaseSession` + `TokenProvider` extraction (§9 #14)                          | **Landed.** `SupabaseSessionCoordinator` is host-neutral and `implements AuthTokenProvider`; storage backend is pluggable.                                                                                                                                                                                                                                                                                                        | CLI provides a file-backed `SupabaseSessionStorage` (`~/.texra/session.json`, chmod 600) and wires the device-code / loopback flow into the existing coordinator. ~150 LOC.                                                                                                                                                                                                                                                |
| Narrow UI ports (§9 #18)                                                         | **Landed.** `PromptHost` / `ExternalOpener` / `DiffViewHost` / `TerminalHost` / `ClipboardHost` all live in `src/hosts/`. The host-neutral _controllers_ are split per-domain under `src/controllers/{mainView,progressView,settingsView}/` (multiple controllers per domain — e.g. `MainViewInteractionController`, `MainViewStartupController`, `MainViewExecutionController`).                                                 | CLI does **not** mount the controllers (they're webview-shaped, one method per renderer message). It calls `executeAgent()` directly. The narrow UI ports (`PromptHost` especially) are reused by approval flows.                                                                                                                                                                                                          |
| `BinaryResolver` for `pdflatex`/`pandoc`/`gm`/Codex (§9 #8)                      | **Landed.** `findToolInCommonPaths()` + `findCodexBinaryPath()` already check Homebrew / TeX Live / MikTeX / global npm / PATH.                                                                                                                                                                                                                                                                                                   | Reused. The Electron-only `app.asar.unpacked` resolution branch is dead code in CLI; everything else works.                                                                                                                                                                                                                                                                                                                |
| `AgentDirectories` resource sync (§9 #19)                                        | **Landed.** The `AgentDirectories` interface + `setAgentDirectories()` injection point live in `src/agent/index/agentRegistry.ts`; host-neutral bootstrap and sync logic live in `src/agent/index/AgentDirectoryService.ts` (170 LOC) + `AgentDirectorySync.ts` (164 LOC), both `vscode`-free. The remaining VS Code-specific watcher shim is `packages/extension/src/frontend/agents/AgentDirectoryManager.ts` — extension-only. | CLI provides its own thin adapters (`AgentDirectoryPathStorage`, `AbsoluteDirectoryAccess`, `AgentDirectoryIssueReporter`, plus `AgentDirectoryStorage` / `AgentDirectoryVersionStore` for sync) against the existing `AgentDirectoryService` + `BundledAgentDirectorySync`. Bundle source is `PathAgentDirectoryBundleSource` pointed at the packaged `resources/agents/`. ~30–50 LOC of CLI-side wiring; no kernel work. |
| Default Node platform impls                                                      | **Landed.** `consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets` (`src/platform/defaults/`, ~462 LOC). All carry the comment "for CLI / Electron / tests".                                                                                                                                                                                                                                 | 5 of 6 used as-is; `EnvSecrets` is replaced by the CLI's keyring-backed `PlatformSecrets`.                                                                                                                                                                                                                                                                                                                                 |
| `vscode`-import audit                                                            | Same 106-of-853 (12.4%) as the Electron PRD reports. None of the 106 are reachable from `executeAgent()`.                                                                                                                                                                                                                                                                                                                         | Confirmed by walking the call graph from `executeAgent.ts:674` — all transitive imports are in the agnostic zones.                                                                                                                                                                                                                                                                                                         |

**Net runtime work for v1**: write a Node shell that calls `executeAgent()`, writes a `ProgressSink` that renders to a TTY or stdout, and adds an approval-policy layer in front of the existing approval coordinators. **No core refactor required.**

### 4.2 Coupling inventory — by tool

| Tool surface                                                                                  | Status in CLI                                                                                                                                                                                                                                  | What's needed                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| File I/O (`read_file`, `write_file`, `edit_file`, `str_replace_editor`, `glob`, `grep`, `ls`) | Reused as-is. All go through `WorkspaceFS` over `getWorkspaceProvider()`. CLI registers a `nodeWorkspace` whose `getWorkspacePath()` returns `process.cwd()`. The `gitignore` module is a utility consumed by the workspace layer, not a tool. | Zero.                                                                                                                 |
| `bash` (foreground)                                                                           | Reused. `executeCommand()` from `@utils/system/execUtils` wraps `execa`; output streams through `onStdout`/`onStderr`.                                                                                                                         | Zero. CLI captures via `ProgressSink`.                                                                                |
| `bash` (background)                                                                           | Reused. Background streams emit to `ProgressEventBus`; CLI consumes those events on its `ProgressSink` and prints a `[bg-stream-1] …` prefix.                                                                                                  | Zero.                                                                                                                 |
| `bash` approval                                                                               | Currently `requestBashApproval` emits `showBashPermission` + waits via `bashApprovalController`.                                                                                                                                               | CLI installs its own settle path: TTY prompt with `@clack/prompts`, or auto-decide per `--approval-policy`. ~120 LOC. |
| `edit_file` approval                                                                          | `requestToolEditApproval` calls `setToolEditApprovalHandler()` (currently `nativeToolEditApproval` in extension).                                                                                                                              | CLI registers a CLI-shaped handler that prints unified diff + prompts on TTY (or auto-decides per policy). ~200 LOC.  |
| `plan` approval                                                                               | `PlanApprovalCoordinator.waitForApproval()` — already host-neutral, no `vscode` import.                                                                                                                                                        | CLI shell renders the plan from the show-event payload + prompts. ~80 LOC.                                            |
| `delegate_workflow` / `delegate_agent`                                                        | Reused — calls `executeAgent()` recursively.                                                                                                                                                                                                   | Zero. CLI sees subagent progress through nested stream IDs.                                                           |
| `external_inquiry` (human-in-loop)                                                            | Currently webview copy/paste flow.                                                                                                                                                                                                             | CLI shows the question on stderr and reads the answer from stdin (or refuses with exit code if `!isTTY`). ~50 LOC.    |
| `memory` (read/write/list)                                                                    | Reused — already goes through `StorageFS` over `nodeStorage` (`~/.texra/global-storage/memories/`).                                                                                                                                            | Zero.                                                                                                                 |
| `todo_write`, `plan`, `executions`, `accept_run_files`                                        | Reused — pure data emission via `ProgressSink`.                                                                                                                                                                                                | Zero in core; CLI renders todos/plans in stream output.                                                               |
| `codex`                                                                                       | Reused. `findCodexBinaryPath()` already falls through to `node_modules` + global npm + PATH; the Electron-only `app.asar.unpacked` branch is skipped naturally.                                                                                | Zero.                                                                                                                 |
| `github_subscription`                                                                         | Reused. Token via `setGitHubTokenProvider`; CLI registers a provider that returns `process.env.GITHUB_TOKEN` (or `GH_TOKEN`).                                                                                                                  | ~10 LOC of registration.                                                                                              |
| `extract_figures`, `extract_bib_entries`, `texcount`                                          | Reused. All shell out via `BinaryResolver` + `execa`.                                                                                                                                                                                          | Zero.                                                                                                                 |

**Verdict**: 14 of the 16 tool surfaces are zero-LOC reuse. The 2 that need work (edit approval, bash approval) need a CLI-specific _handler_ — the underlying coordinators are already abstract.

### 4.3 Coupling inventory — approval and lifecycle gates

The runtime has 7 user-facing gates today (Electron PRD §9 #18 inventory + scout):

| Gate                        | Coordinator                                                         | Already host-neutral?                      | CLI handling                                                             |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Edit approval               | `setToolEditApprovalHandler()` in `core/`, native impl in extension | Coordinator yes; native handler is VS Code | CLI registers its own TTY/policy handler                                 |
| Bash approval               | `bashApprovalController` + `showBashPermission` event               | Coordinator yes                            | CLI installs settle path on event                                        |
| Plan approval               | `PlanApprovalCoordinator` (`BasePromiseCoordinator`)                | **Fully host-neutral.**                    | CLI listens for `showPlanApproval`, prompts, calls `resolvePlanApproval` |
| Agent proposal (delegation) | `AgentProposalCoordinator`                                          | **Fully host-neutral.**                    | Same pattern                                                             |
| Retry request               | `RetryRequestCoordinator`                                           | **Fully host-neutral.**                    | Same pattern                                                             |
| External inquiry            | `awaitExternalInquiryResponse` + `showExternalInquiry` event        | Coordinator yes                            | CLI prompts on stderr + reads stdin                                      |
| Proposal bypass (YOLO)      | `toggleProposalBypass`, per-stream                                  | Pure state                                 | CLI exposes via `--yolo` / `--allow-delegation` flags                    |

The current approval _config_ is binary: `texra.toolUse.requireEditApproval` and `texra.toolUse.requireBashApproval` are bool. CI usage demands richer policies — see §9.

### 4.4 What the CLI is not (and why)

- **Not a TUI port of the progress webview.** The progress view's value (Lit components, virtualized log, codicons, Monaco diff anchor) is GUI-specific. The CLI streams the _same events_ over a textual renderer. We don't try to recreate `<vscode-toolbar-button>` in Ink.
- **Not a settings dashboard in the terminal.** Settings are read-only in the CLI (`texra config get`) plus optional writes via `texra config set` to a single canonical location. No multi-tab form. Power users edit `~/.config/texra/config.yaml` directly.
- **Not a fork of the agent runtime.** Every behavior the CLI surfaces is the same code path the extension and Electron app run. If `polish` rewrites a paragraph differently in CLI vs extension, that's a bug in the kernel, not a CLI feature.
- **Not a thin "shell out to extension" wrapper.** The CLI is a peer host, not a remote-control of an existing extension install. It works on machines that have never seen VS Code.

## 5. Operational modes

The CLI ships in three consumption modes, all from the same binary. Mode selection is automatic where possible (TTY detection), explicit where it must be.

### 5.1 Headless / batch mode (the CI workhorse)

```
texra run polish --input paper.tex --output paper.polished.tex --model claude-opus-4-7
texra run elevate --input paper.tex --rounds 3 --output-format json | jq .
texra run merge --input paper.tex --edited paper.edited.tex --output paper.final.tex
```

**Properties:**

- Non-interactive. `process.stdout.isTTY === false` (piped, redirected, or running under CI) auto-selects this mode. `--print` (alias `-p`) forces it.
- Approval policy default: `never` (no edits/bash without `--approval-policy yolo` or an explicit allow-list). Better to fail loudly in CI than silently auto-approve.
- Exit code reflects outcome: `0` success, `1` agent-reported failure, `2` config / arg error, `3` network / model error, `4` approval denied / timed out, `124` cancelled (matches `timeout(1)` convention), `130` SIGINT (matches shell convention).
- Output: human-readable progress on stderr by default; final output file path on stdout. With `--output-format json` (or `--output-format ndjson` for streaming), structured events go to stdout (one JSON object per line for ndjson) and human messages to stderr.
- No webviews, no TUI components loaded. Cold start matters: `commander` + lazy-loaded subcommands target <80ms before the first kernel call.

### 5.2 Interactive mode (the orchestrator REPL)

```
texra                     # default to chat with orchestrator on cwd
texra chat                # explicit
texra chat --agent devise # pick a different tool-use agent
```

**Properties:**

- TTY-only. Running this in a pipe is a usage error with a friendly hint ("did you mean `texra run …`?"); we do _not_ hang the way Claude Code hangs without `-p` (issue claude-code#9026).
- Ink-based TUI. Top pane: live agent stream (assistant text, tool calls, tool results), with the same in-place updates the desktop progress view shows. Middle pane: the active todo list, plan, or pending approval card. Bottom pane: input prompt with multi-line editor (Ctrl-J for newline, Enter to submit, Ctrl-C to interrupt the active run, Ctrl-D to exit).
- Approvals render inline as modal cards (`@clack/prompts`-style for one-shot prompts, Ink-driven for streaming approval review).
- Resume support: pick up the last tool-use session for `cwd` via `texra chat --resume` (implemented through the existing `resumeToolUseFromSnapshot()` entry point and `ToolUseSessionLifecycle` snapshots).
- Slash commands inside the REPL: `/agent <name>`, `/model <name>`, `/yolo`, `/plan`, `/clear`, `/exit`, mirroring Claude Code conventions where they make sense.

### 5.3 Programmatic mode (the SDK use case)

```ts
import { runAgent } from '@texra/cli/sdk';

const result = await runAgent({
  agent: 'polish',
  inputFile: 'paper.tex',
  model: 'claude-opus-4-7',
  approvalPolicy: 'never',
  onProgress: (event) => {
    /* … */
  },
});
```

**Properties:**

- Public TS API: a thin facade over `executeAgent()` from `@texra/core` that initializes the platform with sensible Node defaults if not already initialized, returns a typed `AgentFlowResult`, and exposes the same callbacks (`onStreamResolved`, `onProgress`, `onCompleted`).
- Used by `texra-action`, by users embedding TeXRA in pipelines (Nx tasks, Snakemake rules, Makefile recipes), and by the CLI itself — the `texra run` command is a thin wrapper over this SDK plus an output renderer.
- Ships from the same npm package as the CLI (`@texra/cli`), exported under a separate entry point so users importing the SDK don't pull in `commander` / Ink.

### 5.4 Mode-selection table

| Trigger                                                                 | Mode         |
| ----------------------------------------------------------------------- | ------------ |
| stdout is a TTY, `CI` env unset, no `--print` flag, no input file given | Interactive  |
| `--print` / `-p` flag passed                                            | Headless     |
| `CI` env truthy (GitHub Actions, GitLab, CircleCI, …)                   | Headless     |
| stdout is not a TTY (piped or redirected)                               | Headless     |
| `import('@texra/cli/sdk')` from another module                          | Programmatic |

The table is enforced by a single `selectMode()` function in `cli/src/runtime/selectMode.ts` (~30 LOC). No deeper logic; mode is decided once at process start and threaded through.

## 6. Decisions (10 core picks)

Each pick is grounded in the May 2026 ecosystem survey + the existing TeXRA codebase. One-line rationale here; deeper justification in §7.

| #   | Concern                | Pick                                                                                                                                                 | Why in one line                                                                                                                                              |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Argument parser        | **`commander`** (option to migrate to `citty` if command count grows past ~30)                                                                       | 500M weekly downloads, zero deps, ~20ms cold start; biggest ecosystem. `citty` is the modern second-place if we want lazy subcommand loading + plugin hooks. |
| 2   | Interactive TUI        | **Ink** (React-for-CLI)                                                                                                                              | What Claude Code, Codex, Gemini CLI use; flexbox layout; live in-place updates fit the progress-view pattern naturally.                                      |
| 3   | Non-interactive output | **`picocolors` + `log-update` + `ora` + `cli-progress`**                                                                                             | Tiny, fast, no React in the headless bundle. Lazy-loaded only when `selectMode() === 'headless'`.                                                            |
| 4   | Inline prompts         | **`@clack/prompts`**                                                                                                                                 | ~4 KB gzipped, opinionated styling, modern default for new CLIs. Used for one-shot approvals in non-Ink contexts.                                            |
| 5   | Config storage         | **`conf` + Zod schemas** (same pick as Electron PRD §6.1)                                                                                            | Single canonical implementation across CLI + Electron; Zod validates at read/write; layered file > env > flag resolution.                                    |
| 6   | Token storage          | **`@napi-rs/keyring`** with `chmod 0600` JSON fallback                                                                                               | Drop-in replacement for archived `keytar`; no `libsecret` build dep on Linux; falls back gracefully in containers.                                           |
| 7   | OAuth flow             | **Loopback HTTP (RFC 8252) + device-code (RFC 8628), in that order**                                                                                 | Loopback for laptops with browsers, device-code for SSH / dev containers / CI debug shells. Both go through the existing `SupabaseSessionCoordinator`.       |
| 8   | Distribution           | **npm `@texra/cli`** with platform `optionalDependencies` for any native deps; secondary `bun build --compile` artifact for users who want zero-Node | Same model as `@openai/codex`. Pure Node CLI doesn't need a self-contained binary — that's a convenience artifact, not the canonical install.                |
| 9   | GitHub Action          | **`texra-ai/texra-action` (JS Action)** + minimal `texra-base-action`                                                                                | Mirrors `anthropics/claude-code-action` + `claude-code-base-action` split. JS Actions are warm-cached and faster than Docker for this use case.              |
| 10  | Module system          | **ESM-first**, Node 20+ minimum                                                                                                                      | Aligns with `@texra/core` (`module: esnext`) and the desktop `nodenext`. CJS-only `pkg`/SEA constraints make Node SEA a poor fit.                            |

### 6.1 Stacks explicitly rejected

- **`oclif`** — Salesforce-grade plugin/topic system, but ~85–135ms cold start and ~30 deps. Overkill for ~20 commands. Reserve for a hypothetical v3 with 100+ commands.
- **`yargs`** — fine, but `commander` is smaller, faster, and more widely deployed.
- **Plain `node:util.parseArgs`** — too low-level for a tree of subcommands; we'd reimplement help generation poorly.
- **`pkg`** — deprecated in 2024.
- **`nexe`** — abandoned.
- **Node SEA** as the canonical distribution — CJS-only; mismatches an ESM-first kernel; ~115 MB binary size.
- **`keytar`** — archived Dec 2022. (Same rejection as Electron PRD §6.3.)
- **`inquirer`** classic — much bigger than `@clack/prompts`; theming layer we don't need.
- **`chalk`** — fine, but `picocolors` is smaller and cold-start-cheaper. We pick the smaller one.
- **A `texra serve` daemon at v1** — interesting future divergence but not v1. Adds an IPC story we don't need yet.
- **A custom config schema framework** — `package.json` `contributes.configuration` (the extension's settings) is already mirrored to a Zod schema (Electron PRD §9 #9). The CLI reuses that schema, period.

### 6.2 Tooling discipline: things we explicitly do NOT add

- **A bespoke logging framework.** `consoleLog` is sufficient; the CLI layer adds color + level filtering via picocolors, not a new abstraction. `pino` is tempting but opinionates JSON output — we already have `--output-format json` for that.
- **`zx` / `execa`-style scripting in the CLI shell.** The CLI calls into `@texra/core`. Shell-outs from the kernel use existing `execa` via `executeCommand`. The CLI shell itself spawns no subprocesses except those the kernel asks for.
- **A custom plugin system.** Users extend TeXRA by writing custom agent YAMLs (existing path) and dropping them in `~/.texra/custom_agents/`. We don't need a CLI plugin loader.
- **A new IPC abstraction** (sockets, named pipes). v1 is single-process. v2's `texra serve` is the right place for that.
- **First-class Windows-only flag handling** beyond what `commander` does natively. Windows users get the same surface as POSIX users.

## 7. Architecture

### 7.1 Repo layout (proposed)

The pnpm workspace skeleton already exists — `packages/{core,extension,desktop}` are created, but `packages/core/src/index.ts` is a stub (`export const corePackageReady = true`) and the kernel still lives at root `src/`. Electron Phase 0's remaining work is the kernel migration into `packages/core/`. The CLI is the fourth peer in the target layout once that migration completes:

```
TeXRA/
├── pnpm-workspace.yaml
├── tsconfig.base.json                  # path aliases live here
├── packages/
│   ├── core/                           # @texra/core — shared kernel
│   ├── extension/                      # @texra/extension — VS Code host
│   ├── desktop/                        # @texra/desktop — Electron host
│   └── cli/                            # @texra/cli — terminal host (NEW)
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsup.config.ts              # esbuild-based bundler for fast ESM build
│       └── src/
│           ├── bin/
│           │   └── texra.ts            # entry point: `#!/usr/bin/env node`
│           ├── runtime/
│           │   ├── selectMode.ts       # TTY/CI detection → 'interactive' | 'headless' | 'sdk'
│           │   ├── initPlatform.ts     # CLI composition root
│           │   ├── progressSink/
│           │   │   ├── headless.ts     # human-readable streaming output
│           │   │   ├── json.ts         # ndjson event stream
│           │   │   └── interactive.ts  # Ink-driven (lazy-loaded)
│           │   └── exitCodes.ts        # canonical exit-code map
│           ├── commands/
│           │   ├── run.ts              # `texra run <agent> --input ...`
│           │   ├── chat.ts             # `texra chat` (Ink REPL)
│           │   ├── agents.ts           # `texra agents list|show`
│           │   ├── models.ts           # `texra models list`
│           │   ├── login.ts            # `texra login [--device-code]`
│           │   ├── logout.ts
│           │   ├── config.ts           # `texra config get|set|path`
│           │   ├── status.ts           # `texra status` (active runs from RunStorageService)
│           │   └── doctor.ts           # `texra doctor` (env check: keys, tex, paths)
│           ├── platform/
│           │   ├── confConfig.ts       # ConfigProvider over `conf`
│           │   ├── fileSecrets.ts      # PlatformSecrets over keyring + file fallback
│           │   └── logToStream.ts      # LogBackend that respects --quiet/--verbose
│           ├── approval/
│           │   ├── policyEngine.ts     # never/yolo/auto/auto-edits/ask
│           │   ├── editApprovalHandler.ts
│           │   ├── bashApprovalHandler.ts
│           │   └── promptHandler.ts    # plan/proposal/retry/external_inquiry
│           ├── auth/
│           │   ├── loopback.ts         # OAuth loopback HTTP server
│           │   ├── deviceCode.ts       # OAuth device-code polling
│           │   └── fileSessionStorage.ts # ~/.texra/session.json (chmod 0600)
│           ├── render/
│           │   ├── diff.ts             # unified-diff renderer (`diff` + picocolors)
│           │   ├── plan.ts             # plan/todo formatter
│           │   ├── stream.ts           # round/turn/tool-call formatter
│           │   └── ink/                # interactive TUI components (lazy chunk)
│           │       ├── App.tsx
│           │       ├── StreamPane.tsx
│           │       ├── ApprovalCard.tsx
│           │       ├── PromptInput.tsx
│           │       └── TodoList.tsx
│           └── sdk/
│               └── index.ts            # public `runAgent()`, `loadAgents()`, `listModels()`
└── (no src/ at root once Electron Phase 0 moves it into packages/)
```

**Layout rationale:**

- One file per concern, but no over-decomposition. `bin/texra.ts` is ~30 LOC (parses args, picks mode, dispatches); the rest is in `commands/`.
- The Ink renderer is in its own subdirectory under `render/` so the bundler can split it into a lazy chunk (Ink + React weighs ~150 KB; we don't load it for `--print` runs).
- `auth/` and `approval/` are CLI-side glue, not new abstractions in core. They register handlers against the existing `SupabaseSessionCoordinator` and `setToolEditApprovalHandler` / `bashApprovalController` seams.
- `sdk/index.ts` is exported under `"./sdk"` in `package.json` `exports` so library users get `import { runAgent } from '@texra/cli/sdk'` without pulling `commander` or Ink.

### 7.2 Code-reuse boundary

What `cli/` imports from `core/` byte-for-byte:

| Path under core             | What it provides                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/`                    | `executeAgent`, `executeMergeAgent`, `resumeToolUseFromSnapshot`, the entire flow infrastructure, every modelHandler                                                                    |
| `agent/runtime/`            | `AgentRuntimeHost`, `ProgressSink`, `InterruptManager`, `RunStorageService`, `BasePromiseCoordinator`, `PlanApprovalCoordinator`, `AgentProposalCoordinator`, `RetryRequestCoordinator` |
| `agent/index/`              | `resolveAgent`, `getAgent`, `AgentDirectoryService`, `BundledAgentDirectorySync`, `setAgentDirectories`                                                                                 |
| `tools/`                    | Every tool (~120 files)                                                                                                                                                                 |
| `tools/approval/`           | `setToolEditApprovalHandler`, `bashApprovalController`, `streamApprovalQueue`, `awaitExternalInquiryResponse`                                                                           |
| `model/`                    | Registry, capabilities, pricing, llm-zoo integration                                                                                                                                    |
| `latex/`                    | LaTeX processing, formatting, diff, TikZ, PDF                                                                                                                                           |
| `shared/`                   | IPC schemas (yes — even though there's no IPC, the schemas validate event payloads)                                                                                                     |
| `replacement/`              | Text cleanup rules                                                                                                                                                                      |
| `eventBus/`                 | Progress event schema                                                                                                                                                                   |
| `auth/`                     | `SupabaseSession`, `SupabaseClient`, `SupabaseSessionCoordinator`, `TokenProvider`, `TierService`, `ServerSideKeyService`                                                               |
| `platform/`                 | All 7 interfaces; `consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets` defaults                                                                  |
| `utils/` (non-vscode parts) | `BinaryResolver`, `findCodexBinaryPath`, `executeCommand`, `userVars`, `outputFileUtils`, `taskRunStorage`, etc.                                                                        |

What `cli/` does **not** import:

- `extension/` — no VS Code commands, no `frontend/`, no `frontend/approval/nativeToolEditApproval.ts`, no `frontend/vscode/*`.
- `desktop/` — no Electron, no preload, no Monaco, no `BrowserWindow`.
- `core/webview/frontend/`, `core/progressView/frontend/`, `core/settingsView/frontend/` — these are Lit, browser-targeted; CLI bundle excludes them.
- `core/controllers/` — the per-domain controllers under `src/controllers/{mainView,progressView,settingsView}/` (e.g. `MainViewInteractionController`, `MainViewStartupController`, `ProgressFollowUpController`, `ProgressStreamLifecycleController`, `SettingsAgentCatalogController`, `SettingsMemoryController`, …) are webview-shaped (one method per renderer message). CLI calls `executeAgent()` directly. The narrow UI ports from §9 #18 (`PromptHost`, `ExternalOpener`) _are_ used.

### 7.3 Platform impls (CLI)

The seven wired services (six `Platform` interfaces plus `PlatformSecrets`) need ~250 LOC of new adapter code (`ConfConfigProvider` + `KeyringSecrets`); the other five reuse the existing `src/platform/defaults/` impls byte-for-byte.

| Interface                | Extension (today)                                                  | Electron (planned)                                   | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigProvider`         | `VscodeConfigProvider` (wraps `vscode.workspace.getConfiguration`) | `ConfConfigProvider` over `conf` (Electron PRD §6.1) | A `ConfConfigProvider` over `conf`, intended to be the same impl Electron will use (Electron PRD §6.1). Neither host has shipped one yet; whichever lands first writes the canonical version into `@texra/core` once the kernel migration completes (§7.1). Layer: defaults from Zod schema → user file (`~/.config/texra/config.yaml`) → project file (`.texra/config.yaml` discovered upward) → env (`TEXRA_*`) → flags. Inspect returns the layered view.                                                  |
| `StateStore` (global)    | `context.globalState` (`vscode.Memento`)                           | `conf` under `app.getPath('userData')`               | `conf` under `os.homedir() + '/.texra/state.json'` for daemon-friendly mode; `memoryState` for one-shot batch (state has no purpose across one-shot invocations and avoids a write to a shared file from CI).                                                                                                                                                                                                                                                                                                 |
| `StateStore` (workspace) | `context.workspaceState`                                           | per-project `conf` keyed by hashed cwd               | Same — `~/.texra/workspace-state/<sha256(cwd)>.json`. Skipped (memory-only) when `--ephemeral` flag passes.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LogBackend`             | `vscode.OutputChannel`                                             | `electron-log`                                       | `consoleLog` reused, plus a `--quiet` / `--verbose` filter wrapper. Optional `--log-file <path>` writes a copy.                                                                                                                                                                                                                                                                                                                                                                                               |
| `FileSystemProvider`     | `VscodeFileSystem` (wraps `vscode.workspace.fs`)                   | `nodeFilesystem`                                     | `nodeFilesystem` — byte-for-byte reuse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WorkspaceProvider`      | `VscodeWorkspace`                                                  | `nodeWorkspace`                                      | `nodeWorkspace` — byte-for-byte reuse. `--cwd <path>` flag overrides `process.cwd()` before init.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `StorageProvider`        | wraps `context.{storage,globalStorage}Uri`                         | `app.getPath('userData')`                            | `nodeStorage` (already writes to `~/.texra/{workspace,global}-storage`) — byte-for-byte reuse. XDG_DATA_HOME fallback added in pre-refactor (§14 C2).                                                                                                                                                                                                                                                                                                                                                         |
| `PlatformSecrets`        | `VscodeSecrets` (wraps `context.secrets`)                          | `safeStorage` + `conf`                               | New `KeyringSecrets`: `@napi-rs/keyring` first, `~/.texra/secrets.json` (chmod 0600) fallback. **The existing `lookupApiKey` (in `src/model/apiProviders.ts`) reads stored secrets first and falls back to `process.env[apiKeyEnvName(provider)]`**, so a user who runs `texra api-key set anthropic …` then unsets `ANTHROPIC_API_KEY` still resolves the stored key. CI runs that pass only env vars work because the stored value is absent and the env-var fallback wins. CLI does not change this order. |

`initPlatform()` is called once from `cli/src/runtime/initPlatform.ts`, before any agent code runs. Mirrors `extension.ts:147`. Lint rule from Electron PRD §9 #15 applies — no other call site.

### 7.4 Process model

- **Single Node process per invocation.** No utility processes, no worker threads, no IPC. The agent runs in the main event loop.
- **No daemon at v1.** Every `texra run` is a fresh process. State that needs to survive (auth tokens, run history, memories) lives in `~/.texra/`. `texra serve` is §18.1 future work for users wanting a long-lived process (e.g., a LSP-style integration).
- **Ctrl-C → graceful cancel.** `process.on('SIGINT')` calls `InterruptManager.onInterrupt()`, which flips the cancel flag and aborts the active `AbortController`. A second SIGINT (or after 5s grace) hard-exits. Mirrors the Codex CLI pattern.
- **Stdin is reserved for the user, not the kernel.** Tools that need user input (external_inquiry, edit/bash approval) read from `/dev/tty` directly when available, falling through to stdin only if `/dev/tty` is unavailable. This means `cat instructions.txt | texra run …` works without confusing the prompt layer.

### 7.5 Replacing extension/desktop UX surfaces

| Extension/desktop UX                                                      | CLI replacement                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity-bar main view (file/agent/model picker)                          | `texra run` arguments + flags; `texra agents list`, `texra models list` for discovery                                                                                              |
| Progress webview (streaming agent output)                                 | Streaming text on stderr (headless) or Ink stream pane (interactive)                                                                                                               |
| Settings webview                                                          | `texra config get/set` + `~/.config/texra/config.yaml` (read-only by default; `set` writes user-scope)                                                                             |
| `vscode.commands.executeCommand('vscode.diff', …)` for tool-edit approval | Unified text diff via `diff` package + picocolors highlighting; `--diff-tool` flag invokes `git difftool`/`code --diff`/etc. as a launch-out for users who want a real diff viewer |
| `dialog.showMessageBox` (Electron)                                        | `@clack/prompts` confirm/select/multiselect                                                                                                                                        |
| Native menu / command palette                                             | `texra --help` tree; in interactive mode, `/`-prefixed slash commands                                                                                                              |
| Walkthrough markdown                                                      | `texra doctor` (env check) + `texra --help <topic>`; the same markdown ships in the npm package as `manuals/` for `man`-style consumption                                          |
| `vscode.window.createTerminal` (for bash background streams)              | Background streams print with a labeled prefix `[bg-1: cmd…]`; foreground streams stream inline                                                                                    |
| `vscode.env.openExternal`                                                 | `open` (mac) / `xdg-open` (linux) / `start` (win) via the `open` npm package; in CI, link is printed to stderr instead                                                             |
| `vscode.AuthenticationProvider`                                           | `texra login` / `texra logout` commands; OAuth via loopback or device-code; tokens in keyring                                                                                      |

### 7.6 SDK surface (programmatic mode)

`@texra/cli/sdk` exports a small typed surface — _not_ the entire `core`. The point is to give batch-job authors a stable contract that survives kernel refactors.

```ts
export interface RunAgentOptions {
  agent: string; // 'polish', 'orchestrator', etc.
  model?: string; // default from config
  inputFile?: string;
  inputFiles?: string[];
  editedFile?: string; // for merge
  outputFiles?: string[];
  instruction?: string; // for tool-use agents
  rounds?: number; // workflow only
  workingDirectory?: string; // defaults to cwd
  approvalPolicy?: ApprovalPolicy;
  allowedTools?: string[]; // for tool-use agents
  disallowedTools?: string[];
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onStreamResolved?: (streamId: string) => void;
}

// Re-exports the kernel's discriminated union directly — see
// @shared/schemas/AgentFlowResult for the canonical shape (workflow +
// toolUse variants, status from EndGroupStatusSchema, outputs as
// OutputFileSummary[], executionId/streamId on the meta extension).
export type RunAgentResult = AgentFlowResult;

export function runAgent(opts: RunAgentOptions): Promise<RunAgentResult>;
export function listAgents(opts?: {
  source?: 'builtin' | 'custom' | 'remote';
}): Promise<AgentSummary[]>;
export function listModels(opts?: {
  provider?: string;
}): Promise<ModelSummary[]>;
```

Internally `runAgent` builds an `AgentConfigPayload` (agent + model + file fields), constructs a per-call `AgentRuntimeHost` whose `ProgressSink` forwards each kernel event to the user's `onProgress`, then calls `executeAgent(payload, undefined, { runtimeHost, onProgress, onStreamResolved, … })`. Types come from `@shared/schemas` so consumers get the same Zod-validated union the kernel emits.

**Caveat (today's runtime shape):** `executeAgent`'s `runtimeHost` is optional and falls back through `AsyncLocalStorage` to a process-global default set by `setDefaultAgentRuntimeHost()`. Two SDK callers in the same process can therefore step on each other's defaults, and approval handlers (`setToolEditApprovalHandler`, `bashApprovalController`) are also module-level singletons. The SDK as specified here is honest about that boundary: it is safe for one consumer per process at v1, and the tracking issue [#3397](https://github.com/LionSR/TeXRA/issues/3397) (kernel hardening: replace ambient globals with an explicit `RunContext`) is the prerequisite for safe re-entrant SDK use. v1 ships with the existing shape; concurrent in-process embedding waits on #3397.

Total surface: ~300 LOC of facade + re-exports.

## 8. CLI surface

Noun-verb tree, modeled on `gh`. Commands listed by category. Each item lists the command, the most useful flags, and where the implementation calls into core.

### 8.1 Agent execution

```
texra run <agent> [--input <file>] [--output <file>] [--rounds N]
                  [--model <name>] [--use-multiple] [--instruction <text>]
                  [--input-files <a,b,c>] [--edited <file>]
                  [--approval-policy <mode>] [--allowed-tools <list>]
                  [--disallowed-tools <list>] [--yolo]
                  [--cwd <path>] [--ephemeral]
                  [--print|-p] [--output-format <text|json|ndjson>]
                  [--quiet] [--verbose] [--log-file <path>]
                  [--timeout <duration>]
```

`<agent>` is a YAML name (`polish`, `correct`, `elevate`, …) or a custom agent ID. `--input` / `--output` / `--rounds` map directly to `AgentConfigPayload` fields. Calls into `executeAgent()` (`agent/runtime/executeAgent.ts:674`).

```
texra chat [--agent <name>] [--model <name>] [--cwd <path>] [--resume]
```

Interactive Ink REPL. `--agent` defaults to `orchestrator`. `--resume` picks the most recent tool-use snapshot under `cwd` and calls `resumeToolUseFromSnapshot()` (`agent/runtime/executeAgent.ts:884`).

```
texra resume [<run-id>]
```

List recent runs (no arg) or resume a specific tool-use run by ID. Reads from `RunStorageService`.

### 8.2 Discovery

```
texra agents list [--source builtin|custom|remote|all] [--category workflow|toolUse]
                  [--output-format text|json]
texra agents show <agent>            # print resolved YAML + inherited prompts
texra agents path <agent>            # print absolute path of YAML
```

Calls `resolveAgent()` / `getAgent()` / `getWorkflowAgents()` / `getToolUseAgents()` / `getAgentsBySource()` from `@agent/index/agentRegistry`. Lists are output-format-aware so `texra agents list -o json | jq '.[] | select(.category=="workflow")'` works in scripts.

```
texra models list [--provider <name>] [--available-only] [--output-format text|json]
texra models show <model>            # capabilities, pricing, context window
```

Reads from `MODEL_CONFIGS` (`llm-zoo`) and gates by `TierService` if signed in.

### 8.3 Auth

```
texra login [--provider supabase|github] [--device-code] [--no-browser]
texra logout
texra whoami
```

`login` defaults to loopback. `--device-code` forces device-code flow for SSH/CI debug shells. `--no-browser` skips the auto-open and prints the URL. See §10.

```
texra api-key set <provider>         # interactive prompt (echo-off) → keyring
texra api-key get <provider>         # prints a masked value, e.g. sk-...last4
texra api-key get <provider> --show  # prints the raw key after confirmation + stderr warning
texra api-key remove <provider>
texra api-key list                   # which providers have keys configured (no values)
```

Provider names match the existing `apiProviders.ts` enum (`anthropic`, `openai`, `google`, `openrouter`, `xai`, `deepseek`, `mistral`, …). `set` always writes through `PlatformSecrets` (keyring → file fallback). `get` is masked by default to avoid leaking secrets into scrollback, transcripts, screen shares, or CI logs; `--show` is an explicit debugging escape hatch and prints a one-line warning to stderr before the confirmation prompt. `lookupApiKey` reads the stored secret first and falls back to the provider's env var (`ANTHROPIC_API_KEY` etc.), so a stored key shadows the env var — `texra api-key remove <provider>` is the way to "switch back to the env var."

### 8.4 Configuration

```
texra config get [<key>]             # all keys if no arg
texra config set <key> <value> [--scope user|project]
texra config unset <key> [--scope user|project]
texra config path                    # resolved layered files
texra config inspect <key>           # which file the value comes from
```

Backed by the same `ConfigProvider` adapter used at runtime. The Zod-canonical key set (Electron PRD §9 #9) gates valid keys — typos produce friendly errors with did-you-mean suggestions.

### 8.5 Diagnostics

```
texra status                          # active runs, queued follow-ups
texra doctor                          # env health check
texra version
texra --help [<topic>]                # per-command help; lazy-loads man pages from manuals/
```

`doctor` checks: Node version, presence of `pdflatex`/`latexmk`/`pandoc`/`gm`, configured API keys (without leaking values), connectivity to model providers (HEAD requests), config file validity, write permissions on `~/.texra/`, keyring backend (`getSelectedStorageBackend()` if applicable). Output is grouped pass/warn/fail with actionable hints — designed to be the first thing CI runs catch issues with.

### 8.6 Environment variables

The CLI honors a small canonical set of env vars in addition to `TEXRA_*` overrides for any config key:

| Variable                                                                                        | Purpose                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, … | Per-provider API keys (existing extension behavior preserved).      |
| `TEXRA_API_KEY`                                                                                 | Reserved for the Supabase relay-tier (server-side keys) flow.       |
| `TEXRA_CONFIG_DIR`                                                                              | Override `~/.config/texra/`.                                        |
| `TEXRA_DATA_DIR`                                                                                | Override `~/.texra/` (matches XDG_DATA_HOME convention).            |
| `TEXRA_LOG_LEVEL`                                                                               | `debug`/`info`/`warn`/`error`.                                      |
| `TEXRA_APPROVAL_POLICY`                                                                         | Default policy when `--approval-policy` isn't passed.               |
| `TEXRA_MODEL`                                                                                   | Default model when `--model` isn't passed.                          |
| `TEXRA_NO_COLOR` (and `NO_COLOR`)                                                               | Disable picocolors output.                                          |
| `TEXRA_NO_TELEMETRY`                                                                            | Disable opt-in telemetry.                                           |
| `CI`                                                                                            | Auto-set by GitHub Actions et al. — flips default mode to headless. |
| `GITHUB_TOKEN` / `GH_TOKEN`                                                                     | Picked up by the `github_subscription` tool.                        |

Config resolution order: **flag > env > project file > user file > schema default**. Single canonical implementation in `ConfConfigProvider.inspect()`; `texra config inspect <key>` shows which layer wins.

## 9. Approval policy engine

The single most important new abstraction the CLI needs. It's also the smallest in LOC — but it's where CI semantics get decided, so it deserves its own section.

### 9.1 The problem

The runtime today exposes 7 user-facing gates (§4.3). Their config is binary: `requireEditApproval: true|false` and `requireBashApproval: true|false`, plus `proposalBypass` per stream. That's enough for the extension (which always has a webview to ask in) but wrong for the CLI:

- A CI run can't prompt. It must auto-approve, auto-deny, or fail.
- A laptop CLI run _can_ prompt — but the user wants to choose granularity ("auto-approve edits inside the project, but ask for bash; never auto-approve outside the project").
- Different agents have different risk profiles. `polish` only edits. `orchestrator` runs bash. The same policy shouldn't apply to both.

### 9.2 The model

The CLI ships a small `ApprovalPolicy` type (matching the Codex CLI vocabulary, with extensions):

| Policy                             | Edit approvals                          | Bash approvals                  | Plan/proposal | External inquiry |
| ---------------------------------- | --------------------------------------- | ------------------------------- | ------------- | ---------------- |
| `never` (default in headless / CI) | Deny silently                           | Deny silently                   | Deny          | Deny             |
| `ask` (default in interactive)     | Prompt on TTY                           | Prompt on TTY                   | Prompt on TTY | Prompt on TTY    |
| `auto-edits`                       | Auto-approve in-project; prompt outside | Prompt                          | Auto          | Prompt           |
| `auto`                             | Auto-approve in-project; prompt outside | Auto in-project; prompt outside | Auto          | Prompt           |
| `yolo`                             | Auto-approve all                        | Auto-approve all                | Auto          | Auto             |

"In-project" means the candidate file/cwd is inside the resolved workspace path (`nodeWorkspace.getWorkspacePath()`). Outside-project edits/bash _always_ prompt under `auto-edits`/`auto`, even when the user opted for high-trust modes — this matches the Codex CLI's default of being conservative across the project boundary.

`--allowed-tools <list>` and `--disallowed-tools <list>` further narrow the tool set the agent sees (passed through to `resolveTools()`); they don't override the approval policy, they precede it. A tool removed by `--disallowed-tools` is not in the prompt at all.

### 9.3 Implementation

A single `ApprovalPolicyEngine` (`cli/src/approval/policyEngine.ts`, ~120 LOC) makes per-gate decisions. Each gate's CLI handler asks the engine first, then either auto-settles or delegates to a TTY prompt:

```ts
// cli/src/approval/editApprovalHandler.ts (~200 LOC)
setToolEditApprovalHandler(async (request) => {
  const decision = policyEngine.decideEdit(request);
  if (decision === 'auto-approve') {
    return { accepted: true, appliedContent: request.proposedContent };
  }
  if (decision === 'auto-reject') {
    return { accepted: false };
  }
  // decision === 'ask' — prompt on TTY (or fail if not TTY)
  if (!process.stdin.isTTY) {
    log.error(
      `Edit approval requested but stdin is not a TTY. Pass --approval-policy yolo to auto-approve.`,
    );
    return { accepted: false };
  }
  printUnifiedDiff(request, process.stderr);
  const answer = await clackConfirm({
    message: `Apply edit to ${request.path}?`,
  });
  return { accepted: answer === true, appliedContent: request.proposedContent };
});
```

Same pattern for bash approval (with `policyEngine.decideBash`), plan approval (always `ask` unless `yolo`), proposal (per-stream `bypass` controlled by `--allow-delegation`/`--yolo`), retry (`ask` if TTY, else "do not retry"), external inquiry (TTY → stdin; non-TTY → fail).

### 9.4 The "ask once for session" pattern

Inside the interactive REPL we add **session-scoped allow lists** the user accumulates as they go:

```
[approval needed]
$ rg --max-count 1 'main' .
Approve? [y]es  [a]llow this command for the session  [n]o  [N]o all
```

`a` adds `rg` (with the same arg shape) to the session's bash allow list; `N` flips the policy to `never` for the rest of the session. This is identical to Codex CLI's REPL semantics; ~80 LOC layered on top of `policyEngine`.

The session allow-list is **not persisted** between `texra` invocations. Persistent allow-lists go in `~/.config/texra/config.yaml` under `approval.allowedBash` etc.

### 9.5 Why this isn't a kernel change

The runtime's existing seams (`setToolEditApprovalHandler`, `bashApprovalController`, the `BasePromiseCoordinator` event pattern) already give us everything we need. The CLI policy engine sits _in front of_ those seams; it doesn't change them. The extension and Electron app keep their existing prompt-driven handlers.

One small kernel change: per Electron PRD §9 #18 the `PromptHost` interface is already defined in `core/hosts/`. The CLI's plan-approval / proposal-approval / retry-approval handlers register a `PromptHost` adapter that calls into `@clack/prompts`. ~60 LOC; no new interfaces.

## 10. Authentication

The CLI must work in three settings, each with a different "where does the token come from" answer:

| Setting                     | Primary path                                                                                                | Fallback                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Laptop with browser         | OAuth loopback (RFC 8252) — loopback HTTP on `127.0.0.1:<port>`, opens browser, captures redirect with PKCE | Device-code if `--no-browser`                                  |
| SSH session / dev container | Device-code (RFC 8628) — print URL + user code, poll token endpoint                                         | `texra api-key set` (no Supabase auth, just personal API keys) |
| GitHub Actions / generic CI | Env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TEXRA_API_KEY`)                                           | None — no interactive auth in CI                               |

### 10.1 Loopback flow

1. CLI starts an HTTP server on `127.0.0.1` with a random free port (Node `net.createServer()` on port 0).
2. Constructs a Supabase OAuth URL with `redirect_to=http://127.0.0.1:<port>/callback` and a PKCE challenge.
3. Opens the URL via the `open` npm package (which respects `BROWSER` env var and falls back to `xdg-open`/`open`/`start`).
4. Waits for the browser callback; the existing `parseAuthCallbackTokens()` from `src/auth/core/authCallback.ts` handles both fragment-based (implicit) and query-based callbacks — reused unchanged.
5. Hands the parsed tokens to `SupabaseSessionCoordinator.setSession()`. From there refresh, expiry, and custom-endpoint logic are the existing host-neutral code.

Total CLI-side code: ~150 LOC. The HTTP server is closed after the first valid callback (or 5-minute timeout). PKCE is mandatory (RFC 8252 §6).

### 10.2 Device-code flow

1. CLI calls Supabase's device-authorization endpoint (`/functions/v1/relay/auth/device-code/start`, **new edge function** — see pre-refactoring §14 C5).
2. Server returns `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`.
3. CLI prints to stderr:

   ```
   To sign in:
     1. Open https://texra.ai/cli/login in any browser
     2. Enter the code: WDJ6-VFQS

   Waiting for authorization (expires in 15 min)…
   ```

4. CLI polls `/functions/v1/relay/auth/device-code/poll` every `interval` seconds with the device code; receives tokens on success, `authorization_pending` while waiting, `slow_down`/`expired_token`/`access_denied` for the documented states.
5. Same handoff to `SupabaseSessionCoordinator` as loopback.

Device-code is also what `texra-action` falls back to if the workflow grants `gh auth login` access (uncommon, but supported). Total CLI-side code: ~200 LOC including the polling state machine.

### 10.3 Token storage

| Layer          | Backend                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary        | `@napi-rs/keyring` — macOS Keychain, Windows Credential Manager, Linux Secret Service / KWallet                                                                    |
| Fallback       | `~/.texra/secrets.json` with `chmod 0600`, owner-only readable; warns on first use that the keyring is unavailable                                                 |
| API keys (env) | Used as the fallback when no stored secret is present (per `lookupApiKey`). `texra login` only writes the Supabase session; it never writes per-provider API keys. |

Same behavior the Electron PRD §6.3 uses. `getSelectedStorageBackend()` analog: detect on Linux whether `gnome-keyring`/`kwallet` is reachable; otherwise log a one-time warning and fall through to the `chmod 0600` file. The Supabase session lives in the same backend (key `texra:supabase:session`), one JSON blob.

### 10.4 Tier checks and the `--use-my-keys` escape hatch

If the user is signed in to Supabase, `TierService` and `ServerSideKeyService` apply: model availability is gated by tier, and the relay endpoint may be used for any provider whose key the user hasn't set personally. This matches the extension's behavior.

Two flags to bypass:

- `--use-my-keys` — disables the relay; even when signed in, the CLI reads only personal API keys. Useful when a user's tier denies a model they have a personal key for.
- `--no-tier-check` — skips the tier preflight on a model. Will fail at request time if the provider rejects, which is an honest failure mode for "I just want to try this model."

Both flags are also config keys (`texra.auth.useMyKeys`, `texra.auth.skipTierCheck`).

### 10.5 Remote agents

Remote agents (loaded from the Supabase relay) are gated identically to the extension: must be signed in, `RemoteAgentLoader.listRemoteAgents()` is called from `texra agents list` when `source` includes `remote`, and `texra run <remote-agent>` requires the session to be valid. No CLI-specific changes — the existing host-neutral flow works as-is.

## 11. Output rendering

The CLI renders the same `ProgressEventBus` events the webviews render. Two renderers behind the same `ProgressSink` interface — the kernel doesn't know or care which is active.

### 11.1 Headless renderer (default for `--print` / non-TTY / CI)

Default human-readable output, designed for `tail -f`-style consumption and grep-friendly logs.

```
[09:14:02] elevate · paper.tex → paper.elevated.tex (round 1/3)
[09:14:18] · model: claude-opus-4-7 · 12,847 input · 2,493 output tokens
[09:14:21] · output: paper.elevated.tex (98 KB, 1,248 lines)
[09:14:21] elevate · round 2/3
…
[09:15:42] elevate · COMPLETED
[09:15:42] · 3 rounds · 287,123 tokens · $0.42 · 1m 40s
paper.elevated.tex
```

- Final output file paths print to **stdout** (one per line) so `texra run polish --input … -o …; cat $(texra run polish --print …)` works in pipelines.
- Progress, errors, telemetry print to **stderr** with timestamp + agent + message.
- Subagent runs (delegate_workflow / delegate_agent) prefix with their stream lineage (`elevate.search · …`).
- Tool calls print one line per call: `bash · ls -la` / `read_file · paper.tex`. The tool result body is suppressed by default; `--verbose` includes it.
- `--quiet` suppresses everything except errors and final stdout output.

`picocolors` for color (auto-disabled when `!process.stderr.isTTY` or `NO_COLOR` is set). `log-update` for in-place spinner updates (`ora` for the spinner itself). ~250 LOC of renderer code in `cli/src/render/stream.ts`.

### 11.2 JSON / NDJSON renderer (`--output-format json` / `ndjson`)

Each `ProgressSink.emit()` event becomes one JSON object on stdout (NDJSON: one per line, terminated by `\n`). The schema is **the same** Zod-validated schema the kernel uses internally — no translation layer, no second source of truth.

```json
{"ts":"2026-05-03T09:14:02.123Z","event":"setActiveStream","streamId":"elev-abc123","agentCategory":"workflow"}
{"ts":"2026-05-03T09:14:02.456Z","event":"setTaskState","streamId":"elev-abc123","taskState":{"status":"running","round":1,"totalRounds":3,…}}
{"ts":"2026-05-03T09:14:18.789Z","event":"updateUsage","streamId":"elev-abc123","usage":{"inputTokens":12847,"outputTokens":2493,…}}
{"ts":"2026-05-03T09:14:21.012Z","event":"addOutputFiles","streamId":"elev-abc123","filesByRound":{"1":[{"path":"paper.elevated.tex","size":98123,…}]}}
…
{"ts":"2026-05-03T09:15:42.345Z","event":"updateStreamStatus","streamId":"elev-abc123","status":"stopped","previousStatus":"running"}
{"ts":"2026-05-03T09:15:42.346Z","event":"endGroup","streamId":"elev-abc123","status":"completed"}
```

The **final** stdout output for `--output-format json` is a single object summarizing the result (`AgentFlowResult` shape) so consumers that just want the bottom line can `tail -1 | jq`. NDJSON streams everything live and is what `texra-action` consumes.

We document the schema in `docs/cli/json-schema.md` and version it via the existing `shared/schemas` package version. Breaking changes to the event schema bump `texra` minor; consumers that pin against a major are stable.

### 11.3 Interactive renderer (Ink TUI)

Lazy-loaded only when `selectMode() === 'interactive'`. ~600 LOC of `.tsx` components in `cli/src/render/ink/`:

- `<App />` — top-level layout, manages keyboard focus and slash-command dispatch.
- `<StreamPane />` — virtualized stream output (using Ink's `<Static />` for completed entries + `<Box />` for the active tail). Renders the same event types as the webview's `progressView`, but as text + ASCII glyphs.
- `<TodoList />` — renders `plan` / `todo_write` state updates as a checkbox list.
- `<ApprovalCard />` — shown over the stream when an approval gate fires; takes focus until resolved. Renders unified diff for edits, command + cwd for bash, plan body for plan approval.
- `<PromptInput />` — multiline input with history (Ctrl-R search), slash-command completion, paste-friendly (Shift-Enter for explicit newline).

Ink + React ship as a separate chunk (~150 KB minified). The headless renderer never imports them. `import('@texra/cli/ink')` is dynamic and gated on `selectMode()`.

## 12. GitHub Actions integration

Two actions in a separate `texra-ai/texra-action` repo (mirrors `anthropics/claude-code-action` / `claude-code-base-action`):

### 12.1 `texra-ai/texra-base-action` — minimal primitive

```yaml
- uses: texra-ai/texra-base-action@v1
  with:
    agent: polish
    input: paper.tex
    output: paper.polished.tex
    rounds: 2
    model: claude-opus-4-7
    approval-policy: never
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

A JS Action (`action.yml` with `runs.using: node20`) that:

1. Caches `@texra/cli` install across runs (key: `texra-cli-${{ inputs.version }}`).
2. Runs `texra run <agent> --input <input> --output <output> --rounds <N> --model <name> --approval-policy <mode> --output-format ndjson`.
3. Streams ndjson events as GitHub Actions log groups.
4. Parses the final summary line and sets `outputs.status`, `outputs.token-cost`, `outputs.outputs-json`.
5. Exits with the CLI's exit code.

~200 LOC of TS in `texra-base-action/src/index.ts`. Designed to be composable.

### 12.2 `texra-ai/texra-action` — high-level integration

```yaml
- uses: texra-ai/texra-action@v1
  with:
    agent: orchestrator
    instruction: '${{ github.event.review.body }}'
    trigger: '@texra'
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Wraps `texra-base-action` with:

- Trigger detection (PR comment `@texra polish`, issue assignment, scheduled prompts).
- PR diff annotation: post inline review comments for each `addOutputFiles` event when triggered on a PR.
- Workspace setup: ensure TeX Live is installed (delegates to a `setup-texlive` step the user adds; we don't bundle TeX).
- Optional commit-back: configurable via `auto-commit: true` to push agent outputs back to the PR branch with a co-author attribution.

~600 LOC. Optional — users wanting their own composition can use `texra-base-action` directly.

### 12.3 Container compatibility

The CLI is verified to run in the standard CI containers:

- `ghcr.io/actions/runner-images/ubuntu-22.04` (default GitHub runner) — Node 20 already installed.
- `node:20-alpine` — works; `@napi-rs/keyring` falls back to file storage (no Secret Service in Alpine).
- `node:20-bookworm-slim` — works; users wanting keyring install `libsecret-tools` if needed.
- `texlive/texlive` (standard TeX Live image) — Node 20 is installed via `apt-get`.
- Dev containers (vscode-style) — works; tests on the `mcr.microsoft.com/devcontainers/typescript-node:20` image.

`texra doctor` runs as the first action of CI integrations to surface missing dependencies clearly.

## 13. Build & compilation

Smaller and simpler than the desktop build pipeline.

### 13.1 Build separation

Independent build graph from extension and desktop. CLI cannot import from `extension/` or `desktop/`; only `core/`. Enforced by ESLint flat-config rule (extension of the §9 #11 rule from the Electron PRD).

| Concern                | CLI build                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Command                | `pnpm --filter @texra/cli build`                                                                                      |
| Bundler                | `tsup` (esbuild-driven; produces ESM `dist/` with one chunk per command + a lazy Ink chunk)                           |
| Module format          | ESM (Node 20+)                                                                                                        |
| Output                 | `packages/cli/dist/bin/texra.js` (entrypoint), `dist/sdk/index.js` (SDK), `dist/render/ink/index.js` (Ink lazy chunk) |
| Dev loop               | `pnpm --filter @texra/cli dev` runs `tsup --watch`                                                                    |
| CI runner              | One Linux runner for build + tests; matrix (linux/mac/windows × node 20/22) for E2E                                   |
| Distribution           | `npm publish` to npm registry; secondary `bun build --compile` for self-contained binaries on GitHub Releases         |
| Allowed to import from | `@texra/core` only                                                                                                    |

### 13.2 Bundle and shipping rules

- The published npm package contains `dist/` only. Sources stay private.
- `package.json` `"bin": { "texra": "./dist/bin/texra.js" }` plus a shebang line; `tsup` adds it.
- `package.json` `"exports"` — the bin executable is reachable only via `"bin"` (don't conflate it with a library entry); `import '@texra/cli'` resolves to the SDK by default, and the CLI shell is intentionally not a library import target:
  ```json
  {
    ".": {
      "types": "./dist/sdk/index.d.ts",
      "import": "./dist/sdk/index.js"
    },
    "./sdk": {
      "types": "./dist/sdk/index.d.ts",
      "import": "./dist/sdk/index.js"
    }
  }
  ```
- Native deps with optional bindings (`@napi-rs/keyring`) ship via `optionalDependencies` so installs don't fail if the platform variant is missing — the file fallback kicks in.
- Bundled bundle size targets: `dist/bin/texra.js` (entrypoint + all non-Ink code) under 4 MB; Ink chunk under 500 KB; SDK under 1.5 MB. CI fails on regression past +20%.

### 13.3 Self-contained binary (secondary)

For users who want zero-Node install, a CI step builds with Bun:

```bash
bun build --compile --target=bun-linux-x64 src/bin/texra.ts -o texra-linux-x64
bun build --compile --target=bun-darwin-arm64 src/bin/texra.ts -o texra-darwin-arm64
bun build --compile --target=bun-windows-x64 src/bin/texra.ts -o texra-windows-x64.exe
```

These attach to GitHub Releases (no signing at v1 — they install via `curl … && chmod +x`, with hashes published). Mac/Windows users wanting signed binaries use the Electron desktop app instead. ~60–80 MB per binary; not the canonical install path.

### 13.4 Tests

| Layer              | Tooling                                                                   | Coverage                                                                                                        |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Kernel             | Vitest + `FakePlatform` (existing — Electron PRD §6.7)                    | Same suite the desktop runs against. CLI inherits invariant-suite coverage automatically.                       |
| CLI smoke          | Vitest in `packages/cli/test/`                                            | `texra agents list`, `texra config get`, exit codes, mode selection, env-var precedence                         |
| CLI E2E            | `execa`-driven tests that spawn the built binary against fixture projects | Headless `polish` run against a tiny `.tex` fixture; JSON output schema validation; approval-policy enforcement |
| Auth               | Mocked Supabase server                                                    | Loopback flow, device-code flow, token refresh                                                                  |
| Renderer (Ink)     | `ink-testing-library`                                                     | Component-level tests of `<StreamPane />`, `<ApprovalCard />`                                                   |
| Cross-platform E2E | GitHub Actions matrix (linux/mac/windows × node 20/22)                    | One end-to-end run per cell on every PR                                                                         |

## 14. Pre-refactorings — what's needed in `core/`

Most of the heavy lifting (Electron PRD's §9 Tier 1) has already shipped. The CLI needs only a small additional set, listed in expected order. Each is independently mergeable.

### Tier 1 — required for v1

(No `AgentDirectories` pre-refactor needed — the host-neutral `AgentDirectoryService` + `BundledAgentDirectorySync` already exist in `src/agent/index/`. The CLI's bootstrap is internal CLI adapter code, listed under Phase 0 deliverables in §15, not a kernel pre-refactor.)

**C1. Unified-diff formatter for CLI approval rendering.** _(~80 LOC.)_

The CLI's edit-approval handler renders a textual diff before prompting. Today's repo already has `diff-match-patch` infrastructure in `src/agent/output/diffComputation.ts` (`computeOutputDiffStats`) and `src/progressView/frontend/formatters/wordDiff.ts` (`generateInlineDiff`), but neither emits a unified-diff patch — they compute stats and inline word-level diffs for the webview. C1 adds a sibling `formatUnifiedDiff(left, right): string` in `src/agent/output/diffComputation.ts` (the natural home alongside the existing diff path) so the CLI's handler doesn't ship its own diff library. **Why now:** without it the CLI either pulls in `diff` or `diff-match-patch-line-mode` separately, and we end up with two diff implementations going out of sync.

**C2. `nodeStorage` honoring `XDG_DATA_HOME` / `XDG_CONFIG_HOME`.** _(~30 LOC.)_

Today `nodeStorage` writes to `~/.texra/{workspace,global}-storage` unconditionally. Linux convention prefers `$XDG_DATA_HOME/texra/` (default `~/.local/share/texra/`) for data and `$XDG_CONFIG_HOME/texra/` (default `~/.config/texra/`) for config. Add a small resolver: `XDG_*` if set, then platform default (`~/Library/Application Support/texra` on mac, `%APPDATA%\texra` on win, `~/.local/share/texra` on linux), then fall back to `~/.texra/` for back-compat. **Why now:** containers, CI, and well-managed user environments all expect XDG; doing this once in core means the CLI and desktop both benefit.

**C3. Headless `PromptHost` adapter.** _(~80 LOC.)_

Per Electron PRD §9 #18, `PromptHost` is already an interface in `core/hosts/`. The CLI provides a `ClackPromptHost` implementation that adapts `@clack/prompts` to the interface; the plan-approval / proposal-approval / retry-approval flows all use it. **Why now:** unblocks §10 (auth flows that need confirmation prompts) and §9.3 (approval engine TTY prompts) without inventing a CLI-only abstraction.

**C4. `ApprovalPolicy` type in `core/agent/runtime/`.** _(~40 LOC.)_

A small typed enum + helper that the CLI populates from flags/config and the kernel optionally consults. The kernel does _not_ enforce policy itself — that's the host's job — but the type lives in core so the SDK and the CLI agree on its shape, and so future hosts (a hypothetical `texra serve` daemon) reuse it. **Why now:** cheap to land, prevents the CLI inventing a parallel type.

**C5. Supabase device-code edge function.** _(~150 LOC of edge function + ~50 LOC of CLI client; new file in `supabase/functions/relay/auth/device-code/`.)_

Supabase Auth doesn't natively expose a device-code flow as of May 2026 (issue #22992 in Claude Code is the same gap). We add a pair of relay endpoints:

- `POST /functions/v1/relay/auth/device-code/start` → issues `{device_code, user_code, verification_uri, interval, expires_in}`. Stores `device_code → session-pending` in a short-TTL table (Postgres `auth_device_codes` with 15-min TTL).
- `POST /functions/v1/relay/auth/device-code/poll` → returns `{access_token, refresh_token, …}` once the user completes the verification page (separate web page that takes the user code, signs the user in via existing OAuth flows, and writes the session row keyed by device code), or `{error: "authorization_pending"}` while waiting.

A small `/cli/login` page on `texra.ai` collects the user code and runs the existing GitHub OAuth flow. **Why now:** SSH/dev-container/CI sign-in is non-negotiable for the CLI, and it doesn't exist on the server yet.

### Tier 2 — useful but not blocking

**C6. `RunStorageService.listActiveRuns()` for `texra status`.** _(~30 LOC.)_

The service tracks active runs internally for the progress webview; expose a read-only listing for CLI consumption. **Why now:** simple, lets CLI surface in-flight runs to the user without scraping logs.

**C7. Bundle-size guard for `@texra/cli/sdk`.** _(~20 LOC of CI script.)_

Make sure the SDK entry point doesn't accidentally pull in `commander` / Ink / chalk — fail CI if `dist/sdk/index.js` exceeds 1.5 MB. **Why now:** prevents users embedding TeXRA in their own pipelines from getting an oversized dep. Tiny, mechanical.

**C8. `--output-format json` schema doc.** _(~200 lines of markdown + a versioning policy.)_

Document the NDJSON event schema with examples, semver policy, and a deprecation path. **Why now:** consumers in the wild (other CIs, scripts, `texra-action`) need a stable contract.

### What's explicitly NOT a CLI pre-refactor (already done)

- Platform-abstraction work (Electron PRD §9 #1, #4, #15, #16, #20) — landed.
- `SupabaseSession` / `SupabaseClient` extraction (§9 #14) — landed.
- Host-neutral controllers + UI ports (§9 #18) — landed (CLI uses the UI ports, doesn't mount the controllers).
- `BinaryResolver` extraction (§9 #8) — landed.
- `AgentDirectories` resource sync (§9 #19) — fully landed (interface + host-neutral `AgentDirectoryService` + `BundledAgentDirectorySync` in `src/agent/index/`). CLI wires its own adapters; bundle source is `PathAgentDirectoryBundleSource` over the packaged `resources/agents/`, user storage at `~/.texra/agents/`.

### Suggested ordering

C2 → C1 → C3 → C4 → C6 → C7 → (C5 in parallel, since it's server-side) → C8.

If everything lands together, ~1.5 engineering weeks.

## 15. Migration phases

Each phase is independently reviewable. The extension and the desktop port never break during this work — every change is additive. Phases 0 and 1 can run in parallel with the Electron PRD's Phase 2 (renderer + main view), since they touch different packages.

### Phase 0 — Workspace package + headless workflow runner (1.5 weeks)

**Gates:** Electron PRD's Phase 0 source move must be merged far enough that `@texra/core` exposes the kernel import surface. CLI lives at `packages/cli/` from the start. The CLI's `AgentDirectoryService` adapters (path storage, dir access, issue reporter, sync storage + version store) ship as part of Phase 0 deliverables — pure CLI-internal wiring against the existing host-neutral classes.

- Add `@texra/cli` package; wire pnpm workspace, tsconfig, tsup.
- Wire `initPlatform()` from `cli/src/runtime/initPlatform.ts` with `consoleLog`, `nodeFilesystem`, `nodeWorkspace`, `nodeStorage`, `memoryState`, `EnvSecrets` (existing defaults). `ConfConfigProvider` and `KeyringSecrets` follow in Phase 2.
- `texra run <agent>` for **workflow agents only** (correct, polish, elevate, devise, criticize, merge, OCR, transcribe). Pulls in `executeAgent()` directly. No tool-use agents yet.
- Headless renderer (text + JSON + NDJSON). No interactive features.
- `texra agents list`, `texra models list`, `texra version`, `texra --help`.
- CI: build + smoke tests on linux/mac/windows × node 20/22.
- **Exit criteria:** `texra run polish --input fixture.tex --output out.tex --model claude-opus-4-7` succeeds end-to-end on all three OSes from a fresh `npm install -g`. JSON output validates against the documented schema.

### Phase 1 — Tool-use agents + approval engine (1.5–2 weeks)

**Gates:** §14 C1 (approval helper) and C4 (`ApprovalPolicy` type) must be merged.

- `texra run <agent>` for tool-use agents (orchestrator, devise, search, generic, …) in **headless mode only**.
- Approval policy engine (`cli/src/approval/`) with `never` / `ask` / `auto-edits` / `auto` / `yolo` modes.
- Edit-approval handler with unified-diff renderer; bash-approval handler with command preview.
- Plan / proposal / retry / external-inquiry handlers via `ClackPromptHost` (C3).
- `--allowed-tools` / `--disallowed-tools` flag wiring through `resolveTools()`.
- `texra resume [<run-id>]` for tool-use snapshots.
- **Exit criteria:** `texra run orchestrator --instruction "..." --approval-policy yolo` runs an end-to-end multi-tool flow against a real LaTeX project. `--approval-policy never` correctly fails when an approval is needed (exit code 4). Approvals on TTY render diffs and respect user input.

### Phase 2 — File-backed config + secrets + auth (1–1.5 weeks)

**Gates:** §14 C2 (XDG paths), C5 (device-code edge function) must be merged.

- `ConfConfigProvider` over `conf` with layered file > env > flag resolution.
- `KeyringSecrets` (`@napi-rs/keyring` + `chmod 0600` fallback).
- `texra login` (loopback + device-code) → `SupabaseSessionCoordinator`.
- `texra logout`, `texra whoami`, `texra api-key set/get/remove/list`.
- Tier check + `--use-my-keys` flag.
- Remote agent loading via existing `RemoteAgentLoader`.
- **Exit criteria:** Sign in on a laptop (loopback) and on an SSH session (device-code). Run a remote agent. Session refresh works after token expiry. Linux fallback warning appears when keyring backend is `basic_text`-equivalent.

### Phase 3 — Interactive REPL (Ink TUI) (2 weeks)

The single largest UI investment in the CLI.

- Ink-based TUI: `<App />`, `<StreamPane />`, `<TodoList />`, `<ApprovalCard />`, `<PromptInput />`.
- Slash commands: `/agent`, `/model`, `/yolo`, `/plan`, `/clear`, `/exit`, `/resume`, `/help`.
- Multiline input with history, paste-friendly, Ctrl-C cancellation, Ctrl-D exit.
- Session-scoped allow-list ("approve this command for the session").
- Lazy-load Ink chunk so headless cold start is unaffected.
- **Exit criteria:** `texra chat` runs a tool-use orchestrator session with live streaming, inline approvals, todo board, and resume support. Tested on iTerm2 (mac), Terminal.app, Windows Terminal, Alacritty, gnome-terminal.

### Phase 4 — `texra-action` GitHub Action (1 week)

- `texra-base-action` (JS Action wrapping the CLI; ndjson → log groups).
- `texra-action` (high-level: trigger detection, PR diff annotation, optional commit-back).
- Smoke workflows in the action repo: a "polish PR" workflow, a "verify after build failure" workflow.
- Documentation: README + example workflows for common LaTeX repos.
- **Exit criteria:** A real LaTeX repo (we use `lionsr/texra` itself for its CHANGELOG.md) runs `texra polish` on PRs in CI and posts inline comments.

### Phase 5 — Polish, docs, distribution (1 week)

- `texra doctor` with full health check.
- Man pages (`manuals/texra-run.1` etc.) generated from command metadata.
- `bun build --compile` artifacts attached to GitHub Releases.
- Docs site additions: `texra.ai/cli/install`, `texra.ai/cli/quickstart`, `texra.ai/cli/json-schema`, `texra.ai/cli/github-action`.
- Telemetry parity with extension (opt-in, anonymous).
- **Exit criteria:** Public v1 release on npm + GitHub Releases. README quickstart works end-to-end for a new user.

**Estimated timeline (single engineer):** 8–9.5 weeks (sum of phase ranges: 1.5 + 1.5–2 + 1–1.5 + 2 + 1 + 1). With a two-engineer team running Phase 1 + Phase 2 in parallel after Phase 0, achievable in 5.5–7 weeks.

This is dramatically smaller than the Electron port's 11.5–13 week budget for the same reason the desktop budget shrunk after the §9 pre-refactorings landed: the kernel is already CLI-shaped. The CLI is a host shell over a host-neutral kernel.

## 16. Risks & mitigations

| Risk                                                                                                                                                                    | Likelihood | Impact   | Mitigation                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-use agents require an approval gate that's hard to express headlessly (e.g., the orchestrator produces a delegation proposal whose feedback shapes the next round) | Medium     | Medium   | The proposal coordinator already supports auto-bypass per stream. CLI's `--approval-policy yolo` flips this for the run; `auto` keeps proposals as approve/reject prompts but auto-decides edits/bash. Document explicitly which gates each policy auto-decides. |
| `process.stdout.isTTY` detection is wrong in some terminals (tmux + alternate-screen, certain SSH multiplexers)                                                         | Medium     | Low      | Always honor `--print` / `-p` as an explicit override; print a one-line hint at startup if the detected mode disagrees with terminal type heuristics.                                                                                                            |
| Device-code flow's polling is rate-limited by Supabase                                                                                                                  | Low        | Medium   | Honor the `interval` server response; back off on `slow_down` per RFC 8628 §3.5. CI debug shells running `texra login` on a slow loop don't hammer the server.                                                                                                   |
| Custom protocol hijack (the loopback flow's listener gets an unexpected callback before the user finishes auth)                                                         | Low        | Medium   | The loopback server only accepts callbacks whose `state` matches the PKCE-bound state we issued. Listener auto-closes after 5-minute timeout or first valid callback.                                                                                            |
| `tsup` produces ESM-only bundles; users on `require()` runtimes can't import `@texra/cli/sdk`                                                                           | Low        | Low      | Document Node 20+ requirement in README. CommonJS users use a dynamic `import()`.                                                                                                                                                                                |
| Ink's React renderer crashes the CLI in headless contexts when accidentally loaded                                                                                      | Low        | Medium   | Lazy-loaded only behind `if (selectMode() === 'interactive')`. Bundler check (C7) enforces it.                                                                                                                                                                   |
| Cold start regresses past target as command count grows                                                                                                                 | Medium     | Low      | Lazy-load each subcommand module via `commander`'s `.action(async () => (await import('./run.js')).run(...))`. Bundle-size guard fails CI on regression.                                                                                                         |
| `--output-format json` schema drift breaks downstream consumers                                                                                                         | Medium     | High     | Schema is versioned with `@shared/schemas`; major bumps imply breaking changes. Document in `docs/cli/json-schema.md`. CI E2E test pins against a captured fixture.                                                                                              |
| Tool-edit approval rendering shows secrets accidentally written to the diff                                                                                             | Medium     | Medium   | Already a kernel concern; add a redaction filter in the `consoleLog` adapter that masks well-known secret patterns (API keys, JWTs) in any printed output.                                                                                                       |
| Subprocess `execa` calls leak `OPENAI_API_KEY` via `ps`-style enumeration                                                                                               | Medium     | Medium   | Same mitigation as Electron PRD: pass keys via stdin / file with restrictive perms where SDKs support it. Audit `execa` call sites.                                                                                                                              |
| GitHub Actions runner caches stale `~/.texra/` between jobs                                                                                                             | Low        | Low      | `texra-base-action` uses `actions/cache` keyed by `${{ runner.os }}-texra-${{ inputs.version }}`; we explicitly do NOT cache `~/.texra/secrets.json` or `~/.texra/session.json`.                                                                                 |
| Cross-platform path handling diverges (especially under git Bash on Windows)                                                                                            | Medium     | Medium   | All path joins go through `node:path` via `nodeWorkspace`; integration tests run on `windows-latest` GitHub runner.                                                                                                                                              |
| Corp proxy / SSL inspection breaks model API or auto-update                                                                                                             | Medium     | Medium   | Honor `HTTP_PROXY` / `HTTPS_PROXY`. `undici` (Node's default HTTP client) supports them by default; verify SDKs do too.                                                                                                                                          |
| `texra-action` uploaded to the Actions marketplace is supply-chain-attacked                                                                                             | Low        | Critical | Pin commit SHAs in published workflows; sign releases with a GitHub App; use `actions/dependency-review-action` in the texra-action repo's CI.                                                                                                                   |
| Telemetry leaks user data                                                                                                                                               | Low        | High     | Off by default; opt-in via `texra config set telemetry.enabled true` or `--telemetry`. Even when on, send only event names and durations — never instructions, file contents, or model outputs.                                                                  |
| Self-contained `bun build` binaries diverge in behavior from npm-installed CLI                                                                                          | Low        | Medium   | E2E test matrix runs both binary and `node dist/bin/texra.js` against the same fixtures.                                                                                                                                                                         |
| External-inquiry tool fails on a CI run that has stdin closed                                                                                                           | Medium     | Medium   | `--approval-policy never` causes the tool to refuse with a clear message; users wanting external-inquiry behavior in CI use a dedicated `--external-inquiry-handler <command>` flag (deferred to v1.1).                                                          |

## 17. Success criteria

- v1 ships `@texra/cli` on npm. `npm install -g @texra/cli && texra doctor` passes on macOS, Linux, Windows, and inside `node:20-alpine` and `texlive/texlive` containers.
- A user can: configure an API key via env or `texra api-key set`, then run `texra run polish --input paper.tex --output paper.polished.tex` end-to-end. No prior TeXRA installation required.
- `texra-base-action` runs on a public LaTeX repo's PR workflow and produces a `polish` output as a PR comment.
- `texra chat` boots into the interactive REPL on TTY, runs an orchestrator session against `cwd`, and respects Ctrl-C cancellation.
- No regression in the VS Code extension or the Electron desktop. Same `pnpm --filter extension build` produces a working VSIX; same `pnpm --filter desktop build` produces signed installers.
- Total **net-new** code in `packages/cli/` under **~3,800 LOC** at v1 (per §19.1: ~2,800–3,800, depending on Ink TUI scope). The CLI shell stays a thin port over the kernel — that's the gate.
- Cold start < 100ms for `texra --help`; < 500ms for `texra run` before the first kernel call.
- `--output-format json` validates against the published schema; CI fixture verifies.
- Auto-detect TTY vs CI correctly in 100% of tested terminals (matrix: iTerm2, Terminal.app, Windows Terminal, Alacritty, tmux, GitHub Actions, GitLab CI, plain SSH).

## 18. Open questions

- **Should `texra serve` (long-lived daemon over Unix socket / HTTP) be in v1 or v2?** Current plan: v2. Single-process `texra run` covers 95% of use cases; daemon is for users embedding TeXRA in IDEs without a TeXRA extension. Defer until demand surfaces.
- **Should the CLI expose an MCP server endpoint?** TeXRA already consumes MCP via tools; offering its own MCP server would let other agents call `texra polish` as a tool. Interesting; defer to v1.1 as a `texra mcp serve` subcommand.
- **What's the npm package name?** Recommendation: `@texra/cli`. Alternatives: `@texra-ai/cli`, plain `texra`. Coordinate with the org owner on npm scope.
- **Should `texra-action` ship from the same repo as the CLI or a separate repo?** Separate repo (`texra-ai/texra-action`) — easier to version independently, easier for users to pin to a specific action version without dragging the CLI version along.
- **Auto-update for the self-contained Bun binaries?** Probably not at v1. Users updating via `npm install -g @texra/cli` is the canonical path; the Bun binaries are convenience artifacts. Re-evaluate if usage data shows the contrary.
- **Telemetry opt-in default**: same as the extension. Confirm with privacy/compliance owner.
- **Should the CLI ship a Docker image** (`texra-ai/texra:1.0.0`) for users who don't want to manage Node themselves? Probably yes for v1.1; image is a thin `node:20-bookworm-slim` + `texlive-base` + `npm i -g @texra/cli` Dockerfile, ~400 MB. Useful for one-off runs in arbitrary CI systems.
- **License compliance** — Ink (MIT), `@clack/prompts` (MIT), `@napi-rs/keyring` (MIT), `commander` (MIT), `picocolors` (ISC). All compatible. Bundle `LICENSES.txt` in the npm package.

### 18.1 Future divergence (post-v1)

Things explicitly out of scope for v1.

- **`texra serve`** — long-lived daemon exposing JSON-RPC / MCP / Unix-socket APIs. Useful for IDE integrations that don't ship their own TeXRA support.
- **`texra mcp serve` / `texra mcp client`** — MCP-server endpoint exposing CLI commands as tools other agents can call.
- **`texra watch <agent> <pattern>`** — file-watcher mode that re-runs an agent on file changes.
- **Plugin system** — let users ship custom tools as npm packages auto-discovered by the CLI. Today, custom tools live in `~/.texra/custom_agents/` YAMLs — no JS plugin loader. Add when users ask.
- **Replay / time-travel** — `texra run --replay <run-id>` to deterministically replay a stored run against a different model. Requires storing model inputs/outputs verbatim.
- **Cost budget guards** — `--max-cost $5.00` exits before hitting a configured spend ceiling. Hooks into `RunUsageAccumulator`.
- **Multi-agent pipelines as code** — a `texra.pipeline.yaml` declarative format that runs multiple agents in sequence (today's `delegate_workflow` is the runtime equivalent; the YAML pipeline would be a CI-friendly serialization).
- **Browser-based REPL** — render the Ink components in an `xterm.js`-backed terminal in the browser. The Electron app could host this as a "command palette" surface.
- **Self-update from the CLI** — `texra upgrade` runs `npm install -g @texra/cli@latest`. Pleasant convenience; not v1.

## 19. Appendix: Reuse-by-the-numbers

From the parallel scout:

| Metric                                                          | Value                                                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total TS files in `src/` (today, pre-monorepo-split)            | 853                                                                                                                                                                         |
| Files importing `vscode` reachable from `executeAgent()`        | **0**                                                                                                                                                                       |
| Platform interface LOC                                          | ~470                                                                                                                                                                        |
| Existing Node-default platform impls (`src/platform/defaults/`) | ~462 LOC across 6 files                                                                                                                                                     |
| Of which CLI reuses byte-for-byte                               | 5 of 6 (`consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`); `EnvSecrets` is replaced by `KeyringSecrets`                                        |
| New CLI-side platform adapters needed                           | 2 (`ConfConfigProvider`, `KeyringSecrets`) at ~180 LOC combined                                                                                                             |
| Tool surfaces fully reused (no CLI shim)                        | 14 of the 16 listed in §4.2 (every entry except the 2 explicitly marked as needing a CLI handler)                                                                           |
| Approval gates fully host-neutral today                         | 5 of 7 (3 standalone `BasePromiseCoordinator`s — plan, proposal, retry — plus the `awaitExternalInquiryResponse` event pattern and the `toggleProposalBypass` state toggle) |
| Approval gates needing CLI-specific settle path                 | 2 of 7 (edit, bash — both have host-neutral controllers; the _handler_ is what's host-specific)                                                                             |
| Approval gates needing CLI-specific handler                     | 2 (edit, bash)                                                                                                                                                              |
| Pre-refactorings still required in `core/`                      | 6 small items (~430 LOC + a server-side edge function)                                                                                                                      |

### 19.1 Effort-by-the-numbers (LOC budget)

#### LOC by phase (`packages/cli/`)

| Phase            | Scope                                      | New LOC          | Modified LOC | Notes                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------ | ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                | Workspace setup + headless workflow runner | 800–1,000        | ~50          | tsup config, `bin/texra.ts`, `commands/run.ts` (workflow path), `commands/agents.ts`, `commands/models.ts`, headless renderer (text + JSON + NDJSON), `nodeStorage` XDG patch                                       |
| 1                | Tool-use + approval engine                 | 600–800          | ~30          | `approval/policyEngine.ts`, `approval/editApprovalHandler.ts`, `approval/bashApprovalHandler.ts`, `approval/promptHandler.ts`, `commands/run.ts` (tool-use path), `commands/resume.ts`, `--allowed-tools` plumbing  |
| 2                | File-backed config + secrets + auth        | 500–700          | ~50          | `platform/confConfig.ts`, `platform/fileSecrets.ts`, `auth/loopback.ts`, `auth/deviceCode.ts`, `auth/fileSessionStorage.ts`, `commands/login.ts`, `commands/api-key.ts`, `commands/config.ts`, `commands/whoami.ts` |
| 3                | Interactive REPL (Ink TUI)                 | 600–900          | —            | `render/ink/App.tsx`, `StreamPane.tsx`, `TodoList.tsx`, `ApprovalCard.tsx`, `PromptInput.tsx`, slash-command dispatch, `commands/chat.ts`                                                                           |
| 4                | `texra-action` GitHub Action               | (separate repo)  | —            | ~800 LOC in `texra-ai/texra-action`, not counted in `cli/` budget                                                                                                                                                   |
| 5                | Polish, docs, doctor                       | 300–400          | ~30          | `commands/doctor.ts`, man-page generator, `commands/status.ts`, telemetry wiring, package metadata                                                                                                                  |
| **Total `cli/`** |                                            | **~2,800–3,800** | **~160**     | Within ~3,500 net-new LOC if Ink TUI lands at the lower end                                                                                                                                                         |

#### LOC by component (`packages/cli/src/`)

| Component                                                                                         | New LOC    |
| ------------------------------------------------------------------------------------------------- | ---------- |
| `bin/texra.ts` (entrypoint)                                                                       | ~30        |
| `runtime/` (mode selection, `initPlatform`, exit codes, headless ProgressSink, JSON ProgressSink) | ~400       |
| `commands/` (~10 commands averaging 80–150 LOC each)                                              | ~1,100     |
| `platform/` (`confConfig`, `fileSecrets`, `logToStream`)                                          | ~280       |
| `approval/` (policy engine + 4 handlers)                                                          | ~500       |
| `auth/` (loopback + device-code + file storage)                                                   | ~450       |
| `render/` (text/diff/plan/stream formatters)                                                      | ~350       |
| `render/ink/` (lazy chunk: App + 5 components)                                                    | ~600       |
| `sdk/index.ts` (public SDK + types)                                                               | ~300       |
| **Subtotal**                                                                                      | **~4,010** |

The discrepancy between the phase-table total and the component-table total is the same accounting nuance as the Electron PRD: the component table counts complete files; the phase table counts what actually ships in each phase, with shared utilities counted once. Net-new is in the **~2,800–3,800 LOC** band.

#### LOC for `core/` and `extension/` changes

| Item                                                     | Net new                   | Modified |
| -------------------------------------------------------- | ------------------------- | -------- |
| §14 C1 (approval helper)                                 | ~80                       | —        |
| §14 C2 (XDG paths in `nodeStorage`)                      | ~30                       | ~10      |
| §14 C3 (`ClackPromptHost`)                               | ~80                       | —        |
| §14 C4 (`ApprovalPolicy` type)                           | ~40                       | —        |
| §14 C5 (Supabase device-code edge function + CLI client) | ~200 (server) + ~50 (CLI) | —        |
| §14 C6 (`listActiveRuns()`)                              | ~30                       | —        |
| §14 C7 (bundle-size guard CI script)                     | ~20                       | —        |
| §14 C8 (JSON schema docs)                                | ~200 (markdown)           | —        |
| **Subtotal core/extension/server**                       | **~730**                  | **~10**  |

#### Aggregate budget

| Bucket                                  | Net new LOC      | Modified LOC | Total touched    |
| --------------------------------------- | ---------------- | ------------ | ---------------- |
| `packages/cli/`                         | 2,800–3,800      | ~160         | ~2,960–3,960     |
| `packages/core/` (CLI pre-refactors)    | ~730             | ~10          | ~740             |
| `texra-ai/texra-action` (separate repo) | ~800             | —            | ~800             |
| **Total v1**                            | **~4,330–5,330** | **~170**     | **~4,500–5,500** |

For comparison: the existing extension is ~853 source files. The agent core (reused unchanged) is ~141 files. The CLI port is **~5% of the existing source base** in net-new code; the §14 items are purely additive — interface additions, new defaults, and new edge functions — with no rewrites of existing kernel logic. The CLI is the smallest of the three host shells precisely because the kernel is already CLI-shaped — the bulk of "make this host-neutral" engineering was done in the §9 pre-refactorings the Electron PRD drove.

#### What's NOT counted in this LOC budget

- **Configuration files**: `tsup.config.ts`, `package.json`, GitHub Actions workflows. ~200 LOC of YAML / JSON / TS config.
- **Tests**: Vitest suites, Playwright matrix. ~600–1,000 LOC.
- **Documentation**: install guide, JSON schema reference, GitHub Actions guide, man pages. Markdown only.

Total config + tests + docs: another ~1,000–1,500 LOC of non-application code spread across the project.

## 20. Tech stack one-liner

```
commander (or citty) + Ink (lazy) + picocolors + log-update + ora + @clack/prompts
- conf + Zod + @napi-rs/keyring (file fallback)
- OAuth loopback + device-code (RFC 8252/8628) over existing SupabaseSessionCoordinator
- tsup for ESM build; bun build --compile for self-contained binaries (secondary)
- pnpm workspace package #4 (cli) alongside core/extension/desktop
- Vitest + execa-driven E2E + ink-testing-library + GitHub Actions matrix
- texra-base-action + texra-action (JS Actions in texra-ai/texra-action)
```

That's the whole story. The agent core is already CLI-shaped — this PRD is just describing how to wrap it in `process.argv` + a TTY.

---

## 21. Iteration log — round 2 (2026-05-05)

Round 1 above defined the CLI as a thin Node shell over an already host-neutral kernel. Two follow-on investigations sharpened that picture:

1. **Runtime audit** of every `AsyncLocalStorage` scope and module-level `let foo: X | undefined` setter pair across `src/agent/`, `src/tools/approval/`, `src/auth/`, `src/eventBus/`, and `src/logger/`. The audit names ~20 ambient bindings and ~3 singleton coordinators that v1 of the SDK has to live with but a v1.1 MCP-server / re-entrant SDK cannot.
2. **Ecosystem survey** of Codex CLI (Rust + TOML + `codex mcp` + `codex exec --json --output-last-message`), Claude Code (`claude mcp serve`, JSONL transcripts under `~/.claude/projects/<hash>/`, hook contract with `permissionDecision` namespacing, `--output-format stream-json`), OpenCode (Bun HTTP server + Go TUI generated from OpenAPI 3.1.1, `permission` map with glob+last-match semantics), and the `claude-code-base-action` composite-action / Bun-runner pattern.

**User-feedback intake (2026-05-05):**

- Sandbox-mode dimension on approval policy is too complicated; round-1's 1D `never|ask|auto-edits|auto|yolo` stays. We do not adopt Codex's 2D `approval × sandbox` matrix. (See §26 for the rejection rationale.)
- Unifying agent-SDK / message-SDK with conversation compaction is a desirable cross-host goal but **not v1 scope** — parked in §32 alongside other v2+ work.

Round 2 lands six concrete deltas plus one cross-cutting kernel refactor that all three hosts (extension, desktop, CLI) benefit from. None of these change the round-1 LOC band by more than ~600 lines combined; most are about replacing ad-hoc patterns with the kernel-shaped abstractions the audit revealed are already partially in place.

| Delta                                                                         | Round 1 status                                       | Round 2 position                                                                                                | New §      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| Explicit `RunContext` replaces ambient ALS + singletons (§7.6 caveat / #3397) | Tracked as future work                               | **v1 prereq for `texra mcp serve` and re-entrant SDK; v1.0 ships with the migration shim path**                 | §22        |
| Structured logger with explicit context, no module globals                    | Hand-waved as "consoleLog plus filter wrapper"       | **v1 deliverable; `LogBackend` interface widened to take a context object**                                     | §23        |
| `texra mcp serve` (callable from Claude Code, Codex, opencode)                | Listed as v1.1 future                                | **Promoted to v1; minimum surface = three tools (`run_workflow`, `run_chat`, `list_agents`)**                   | §24        |
| Hook system (SessionStart, PreToolUse, PostToolUse, …)                        | Not mentioned                                        | **v1.1 — copy Claude Code's contract verbatim; spec'd here so v1 doesn't paint itself into a corner**           | §25        |
| Approval policy revisited (no 2D sandbox axis)                                | 1D `never                                            | ask                                                                                                             | auto-edits | auto | yolo` | **Stays 1D per user feedback. Round 2 sharpens the "in-project / outside-project" semantics with concrete file:line rules.** | §26 |
| Session transcripts as JSONL under project-hash sharding                      | Implicit reuse of `RunStorageService` snapshot files | **Explicit format; `texra resume` / `--continue` / `--fork-session` semantics**                                 | §27        |
| GitHub Action: composite + Bun (not JS Action)                                | §12 picked JS Action                                 | **Reverse — match `claude-code-base-action`'s composite pattern; faster iteration, no `dist/` checked in**      | §28        |
| Cross-platform shared structure refactor (kernel side)                        | Implicit                                             | **Explicit — what the three hosts share, what they don't, where the seams go**                                  | §29        |
| Container / GitHub-runner target matrix (slim, alpine, texlive)               | Sketched in §12.3                                    | **Refined per survey; `node:20-alpine` is downgraded to "best-effort" because of glibc/Bun/native-deps issues** | §30        |
| Phase plan delta + LOC delta                                                  | —                                                    | **Aggregated**                                                                                                  | §31        |
| Parking lot — unified agent-SDK / message-SDK / context compaction            | —                                                    | **Out of v1; sized in §32 for visibility**                                                                      | §32        |

The rest of round 2 is the spec for these deltas, in dependency order: §22 → §23 unblock §24 (an MCP server can't safely host concurrent sessions until the kernel's ambient state is gone); §24 + §25 + §26 are independent hosts on the new context; §27 + §28 + §29 + §30 are deployment / packaging concerns that don't gate kernel work.

## 22. RunContext — replace ambient ALS + singletons

### 22.1 What's ambient today

The May 2026 runtime audit (in commit-time order, not severity) found:

**AsyncLocalStorage scopes (2):**

- `src/agent/runtime/AgentRuntimeHost.ts:12` — `runtimeHostScope` carries the current `AgentRuntimeHost` (≡ `ProgressSink`). Entered via `runWithAgentRuntimeHost(host, fn)` at line 27; read via `getAgentRuntimeHost()` at line 23 with fallback to a process-global `defaultAgentRuntimeHost` (line 11) and then to `getDefaultProgressSink()` (`ProgressSink.ts:20`).
- `src/logger/logUtils.ts:10` — `contextStorage` carries a `Map<channel-key, group-id stack>` so `runWithGroupContext()` can attach a `[groupId]` tag to each line. Read at lines 63 and 136.

**Module-level `let X | undefined` + setter pairs (~20):**

| Concern                         | Setter                            | File:line                                       |
| ------------------------------- | --------------------------------- | ----------------------------------------------- |
| Default progress sink           | `setDefaultProgressSink`          | `src/agent/runtime/ProgressSink.ts:14`          |
| Default runtime host            | `setDefaultAgentRuntimeHost`      | `src/agent/runtime/AgentRuntimeHost.ts:11`      |
| Run storage service             | `setRunStorageService`            | `src/agent/runtime/RunStorageService.ts:10`     |
| Tool-edit approval handler      | `setToolEditApprovalHandler`      | `src/tools/approval/toolEditApproval.ts:74,113` |
| Latex-preview handler           | `setLatexBuildDisplay`            | `src/tools/approval/latexPreview.ts:21`         |
| GitHub token provider           | `setGitHubTokenProvider`          | `src/tools/github/githubAuth.ts:13`             |
| Extension checker               | `setExtensionChecker`             | `src/tools/externalToolDefs.ts:35`              |
| Server-side key service         | `setServerSideKeyService`         | `src/auth/serverKeys/index.ts:34`               |
| Tier service                    | `setTierService`                  | `src/auth/tier/index.ts:31`                     |
| Auth callback resolver          | `setExternalAuthCallbackResolver` | `src/auth/config.ts:183`                        |
| Runtime extension id            | `setRuntimeExtensionId`           | `src/auth/config.ts:137`                        |
| Output-channel factory (logger) | `setOutputChannelFactory`         | `src/logger/logUtils.ts:108`                    |

**Exported singleton coordinators (3):**

- `planApprovalCoordinator` — `src/agent/runtime/PlanApprovalCoordinator.ts:128`
- `retryCoordinator` — `src/agent/runtime/RetryRequestCoordinator.ts:145`
- `proposalCoordinator` — `src/agent/runtime/AgentProposalCoordinator.ts:89`

**Caches that survive across runs (4):**

- Agent-registry cache + init promise — `src/agent/index/agentRegistry.ts:143,146-147`
- Execution listing cache + workspace-path cache — `src/agent/storage/executionListing.ts:52-54`
- Output-poll timer + in-flight flag — `src/agent/runtime/executionRegistry.ts:335-336`
- Polish-model template cache — `src/agent/runtime/polishModel.ts:11-12`

### 22.2 Why this hurts the CLI

Round-1 §7.6's caveat — "two SDK callers in the same process can step on each other's defaults" — covers only the tip. The full failure surface for the CLI is:

1. **`texra mcp serve` (§24)** must host N concurrent sessions in one process, each with its own progress sink, its own approval policy, its own logger context, and its own abort signal. Today's ambient-default + ALS-fallback model conflates "this run's sink" with "this process's sink"; an MCP server that serves two clients simultaneously will leak progress events between them whenever a `getDefaultProgressSink()` path is hit (which the audit shows is the default fallback in `getAgentRuntimeHost` at `AgentRuntimeHost.ts:24`).
2. **Re-entrant `runAgent()` from the SDK (§7.6)** — same problem. A user piping two polish runs in parallel through `Promise.all([runAgent(...), runAgent(...)])` will see interleaved progress on whichever process-global sink the second call happened to install last.
3. **Hooks (§25)** that fire from a sub-flow (e.g., `PreToolUse` raised inside a delegate-agent subagent) need the hook handler to know which session it belongs to. The ALS scope already passes the runtime host correctly, but the singleton coordinators (`planApprovalCoordinator`) don't — they fan out events to whoever the current global handler is.
4. **Tests** routinely have to `setDefaultProgressSink(noop)` and `setRunStorageService(fake)` in `beforeEach` and unwind them in `afterEach`. A `RunContext` argument removes ~150 LOC of this kind of setup.

### 22.3 The shape

A single `RunContext` value, threaded explicitly through the call graph, with one ALS scope at the outermost entry to support legacy call sites during migration. No module globals, no per-domain singletons.

```ts
// packages/core/src/runtime/runContext.ts
export interface RunContext {
  /** Stable identifier for this run; root for child contexts. */
  readonly runId: RunId;
  /** Stream tab id within the run (one per agent activation). */
  readonly streamId: StreamTabId;
  /** Lineage from the user-initiated root, useful for log prefixes. */
  readonly streamLineage: StreamTabId[];

  /** Where progress events go. Replaces `getAgentRuntimeHost()`. */
  readonly progress: ProgressSink;
  /** Structured logger scoped to this run. Replaces `logUtils` group-context ALS. */
  readonly log: Logger;

  /** Cooperative cancel signal for this run. Replaces InterruptManager singleton. */
  readonly signal: AbortSignal;

  /** Approval policy for this run (resolved from flag > env > config > schema default). */
  readonly approval: ApprovalPolicy; // 1D — see §26

  /** Workspace root (cwd) for this run. Per-run override of WorkspaceProvider. */
  readonly workspaceRoot: string;

  /** Runtime-resolved capabilities. Replaces `setExtensionChecker`, `setGitHubTokenProvider`. */
  readonly capabilities: RunCapabilities;

  /** Coordinators bound to this run's progress sink. Replaces exported singletons. */
  readonly coordinators: {
    plan: PlanApprovalCoordinator;
    proposal: AgentProposalCoordinator;
    retry: RetryRequestCoordinator;
    edit: ToolEditApprovalController;
    bash: BashApprovalController;
  };

  /** Spawn a child context for a delegate_agent / delegate_workflow subagent. */
  child(opts: ChildContextOptions): RunContext;
}

export interface RunCapabilities {
  github: GitHubTokenProvider | null;
  extensionPresent: boolean;
  externalAuthCallback: ExternalAuthCallbackResolver | null;
  // …other host capabilities, populated by the host adapter
}
```

`buildAgentLaunchContext()` in `executeAgent.ts:166` already constructs almost all of this; the round-2 refactor is to (a) lift it to the kernel boundary so it's the only entry point that matters and (b) pass it explicitly into every coordinator method that today reads from a singleton.

### 22.4 Migration shim

Because the audit found ~30 sites that read singletons today, a hard cutover is not realistic for v1. The shim:

- `runContextScope = new AsyncLocalStorage<RunContext>()` lives in `packages/core/src/runtime/runContext.ts`.
- `withRunContext(ctx, fn)` wraps every `executeAgent()` call. The existing `runWithAgentRuntimeHost()` wrapper is kept and now reads from `runContextScope.getStore()` for forward compatibility.
- Every singleton getter (`getDefaultProgressSink()`, `getRunStorageService()`, `getServerSideKeyService()`, …) gets a `// LEGACY:` comment and a path forward: it reads `runContextScope.getStore()?.<field>` first and falls back to the module global.
- Internal kernel call sites are converted in batches (one per phase): coordinators first (Phase 0 of round 2), then approval handlers (Phase 1), then auth services (Phase 2). Each batch deletes a module global once its readers all take an explicit `ctx`.
- ESLint rule `no-ambient-runtime-state` blocks new module-level `let` + setter pairs in `src/agent/`, `src/tools/`, `src/auth/`. Rationale: same shape as the §13.1 import-restriction rule.

### 22.5 Migration order (gated on, not blocking, CLI v1.0)

| Round                          | Singletons retired                                                                                                                              | Files touched                                                                       | Net LOC    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| Pre-v1.0                       | `runContextScope` lives at boundary; `runWithAgentRuntimeHost` reads it; new `Logger`/`progress` getters on context (§23)                       | `executeAgent.ts`, `runContext.ts` (new), `Logger.ts` (new)                         | +180 / -10 |
| v1.0                           | `planApprovalCoordinator`, `proposalCoordinator`, `retryCoordinator` become per-context instances created in `buildAgentLaunchContext()`        | `Plan/Retry/AgentProposalCoordinator.ts`, ~5 call sites                             | +60 / -30  |
| v1.1 (gates `texra mcp serve`) | `defaultProgressSink`, `defaultAgentRuntimeHost`, `runStorageService` singletons removed                                                        | `ProgressSink.ts`, `AgentRuntimeHost.ts`, `RunStorageService.ts` + ~40 reader sites | +0 / -120  |
| v1.2                           | `setToolEditApprovalHandler`, `setGitHubTokenProvider`, `setExtensionChecker`, `setLatexBuildDisplay` — replaced by `RunCapabilities` injection | `tools/{approval,github,externalToolDefs}/*`                                        | +40 / -90  |
| v1.3                           | Auth singletons (`tierService`, `serverSideKeyService`) become per-`RunContext` resolutions backed by a kernel-side `AuthRegistry`              | `auth/*`                                                                            | +60 / -100 |

Net: at v1.3 the kernel has zero `let X | undefined` + setter pairs in the agnostic zones, and ~250 LOC has been deleted on net. The CLI's `texra mcp serve` becomes safe at the v1.1 boundary; v1.0 ships with the shim.

### 22.6 Why not "just drop ALS entirely"

The shim is necessary because the kernel has 30+ call sites that read the runtime host implicitly (every emit, every approval prompt, every coordinator call). A pure-explicit migration would touch 30+ files in one PR and break every in-flight branch. ALS-with-an-explicit-context is the ergonomic compromise OpenTelemetry, Vercel AI SDK, and Encore all settled on; we copy that. The audit confirms zero call sites of `getStore()` outside the `runtimeHostScope`/`contextStorage` files themselves, so wrapping access in a single `useRunContext()` helper is a one-line change at every reader.

### 22.7 The "stream context lost across `.then()`" risk

The LangSmith #2274 issue is the canonical foot-gun: ALS context can be lost when a stream's `.then()` resolves outside the original async chain. We have one such site today — `RunStorageService`'s background poll timer (`executionRegistry.ts:335`) fires outside any `runWithAgentRuntimeHost()` scope. The mitigation is the same one the survey flagged: bind the context at registration time. Practically: `pollInFlight` becomes a `Map<RunId, RunContext>` and the timer callback uses `withRunContext(stored, fn)` rather than reading whatever scope happens to be active. ~20 LOC.

## 23. Logger v2 — structured events, explicit context, no module globals

### 23.1 What's wrong with today's logger

`src/logger/logUtils.ts` is a serviceable VS Code-shaped logger. It is also wrong for the CLI in three concrete ways:

1. **`outputChannelFactory` (line 21) and the `channels` Map (line 19) are module-level state.** The audit finds exactly one setter in production code (`packages/extension/src/extension.ts`), but tests and an MCP-server mode that hosts concurrent runs cannot safely share these. The `setOutputChannelFactory(null)` reset disposes channels for _every_ concurrent caller.
2. **Group context lives in its own ALS (`contextStorage`, line 10), separate from the runtime host's ALS (`runtimeHostScope`, `AgentRuntimeHost.ts:12`).** A sub-agent that emits a log line passes through both scopes; the two are kept in sync by convention, not enforcement.
3. **`writeLine` calls `getConfig('texra.logger.debugMode', false)` on every line (line 79).** That's fine in the extension where `getConfig` is a wrapped `vscode.workspace.getConfiguration`, but in the CLI before `initPlatform()` runs (which the audit shows happens for ~40 module-load-time `initialize()` calls), the config provider may not exist yet. Today's `tryPlatform()` fallback works because `getConfig` returns the default; in the CLI we want stricter guarantees that log lines emitted during boot don't silently lose their context.

Plus a non-bug observation: the JSON / NDJSON renderer specced in round 1 §11.2 is a _separate_ code path from the human renderer. Two formats, one schema is fine; two formats, two code paths is duplication waiting to bit-rot.

### 23.2 Shape

A single `Logger` interface that is part of `RunContext` (§22.3), with sinks plugged in by the host:

```ts
// packages/core/src/runtime/logger.ts
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;

  /** Push a group; returned function pops it. Replaces logUtils' ALS. */
  group(label: string): () => void;
  /** Wrap an async fn in a group; returns its result. */
  withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T>;

  /** Per-domain child — adds a static field to every emission. Cheap. */
  child(fields: LogFields): Logger;
}

export interface LogFields {
  /** Stream lineage. Auto-injected by RunContext.log; usable by hosts for prefix. */
  readonly streamId?: StreamTabId;
  readonly runId?: RunId;
  readonly groupId?: string;
  /** Free-form structured data; the host decides whether to render it. */
  readonly [k: string]: unknown;
}
```

The host registers a single `LogSink` (renamed from `LogBackend` to make explicit that it consumes structured records, not formatted strings):

```ts
export interface LogRecord {
  ts: string; // ISO-8601 with millis
  level: LogLevel;
  message: string;
  fields: LogFields;
  groups: readonly string[]; // current group stack at emit time
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
}
```

### 23.3 What each host installs

| Host         | Sink                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension    | `VscodeOutputChannelSink` — writes formatted strings to `vscode.OutputChannel` (today's behavior). One channel per agent.                                                                                            |
| Desktop      | `electronLogSink` over `electron-log` (Electron PRD §6.4); same channel-per-agent shape.                                                                                                                             |
| CLI headless | `StderrTextSink` — picocolors-formatted; respects `--quiet` / `--verbose` / `NO_COLOR`. Also writes to `--log-file` if passed.                                                                                       |
| CLI JSON     | `NdjsonStdoutSink` — one JSON object per line, schema-validated against `LogRecord`. **This is the same data path §11.2 specs as the event stream — log records and progress events share the JSON Lines envelope.** |
| CLI MCP      | `McpProgressSink` — converts each record to an MCP `notifications/progress` payload bound to the request's progress token. Respects the client's progress-update opt-in.                                             |
| Tests        | `MemorySink` — pushes records into an array for assertion; auto-installed via `withRunContext()` in `vitest.setup.ts`.                                                                                               |

### 23.4 Rendering rules — round-1 §11 reconciled

Round 1 §11.2 specifies an NDJSON event stream. Round 2 unifies it with the log stream:

- Every `LogRecord` is also a `ProgressEvent` with `event: "log"`. The schema is `LogRecord ∪ ProgressEventPayloads` (a Zod discriminated union on `event`).
- Consumers that care only about logs filter `event === "log"`. Consumers that care only about progress (e.g. `texra-action`'s log-group renderer) filter `event !== "log"`.
- Schema lives in `packages/shared/schemas/runStream.ts` (new). Versioned per round-1 §11.2's policy.
- The headless text renderer (`StderrTextSink`) renders `event === "log"` lines as `[time] [agent] message` and `event !== "log"` lines as the structured progress format. One renderer, two sub-paths, one schema.

### 23.5 Group context migration

The current `runWithGroupContext()` is replaced by `RunContext.log.withGroup()`. The migration is mechanical:

```ts
// before
await runWithGroupContext(channel, groupId, isAgent, async () => {
  logger.info(channel, 'doing thing');
});

// after
await ctx.log.child({ channel }).withGroup(groupId, () => {
  ctx.log.info('doing thing');
});
```

Both forms run for one release; the old form is `@deprecated` and routes to the new one. The `contextStorage` ALS in `logUtils.ts:10` is deleted at the end of the migration.

### 23.6 Boot-time logging

The CLI emits ~3–5 log lines before `initPlatform()` returns (config layer load, secret resolution, agent-directory bootstrap). Today these go through `console.info` at module load time. Round 2 routes them through a `BootstrapLogger` — a `Logger` impl that buffers records into an array until `initPlatform()` finishes, then flushes them through whichever sink the host registered. ~30 LOC. No more "config debug toggle silently broken during boot."

### 23.7 LOC accounting

| Item                                                                                                                             | New                 | Modified | Deleted |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------- | ------- |
| `packages/core/src/runtime/logger.ts` (new — interface + bootstrap logger + group helpers)                                       | ~180                | —        | —       |
| `packages/core/src/runtime/runContext.ts` (logger threaded as field)                                                             | (counted under §22) | —        | —       |
| `src/logger/logUtils.ts` (kept for legacy callers; routes to new logger)                                                         | —                   | ~80      | —       |
| `src/logger/AgentLogger.ts`, `AgentUsageReporter.ts` (route through `ctx.log`)                                                   | —                   | ~40      | —       |
| Per-host sinks: `VscodeOutputChannelSink` (extension), `StderrTextSink` + `NdjsonStdoutSink` (CLI), `McpProgressSink` (CLI v1.1) | ~250                | —        | —       |
| `texra config` exposes `logger.debugMode` via `ConfigProvider.watch()`; remove the per-write `getConfig` lookup                  | —                   | ~10      | ~5      |
| **Subtotal**                                                                                                                     | **~430**            | **~130** | **~5**  |

This counts against §14's pre-refactor budget (~430 → ~860 with logger v2 added). Within the engineering-week envelope from §15 because §22 + §23 deliverables are the natural prerequisite for §24.

## 24. `texra mcp serve` — callable from Claude Code, Codex, and opencode

### 24.1 Why now

Round 1 §18.1 deferred MCP-server mode to v1.1. Round 2 promotes it to v1 because the survey is unambiguous: every CLI in this category (Claude Code's `claude mcp serve`, OpenAI Codex's `codex mcp`, opencode via its OpenAPI server) ships a stdio MCP server as its delegate-from-another-agent surface. A TeXRA CLI without one is an island.

The user's framing — "to be callable by Claude Code and Codex etc" — is exactly this surface. From a Claude Code session, the user adds:

```jsonc
// .mcp.json (project) or ~/.claude/mcp.json (user)
{
  "mcpServers": {
    "texra": {
      "command": "texra",
      "args": ["mcp", "serve"],
    },
  },
}
```

… and Claude Code can now call `texra__run_polish`, `texra__run_elevate`, `texra__list_agents`, etc. as tools. The Codex equivalent goes in `~/.codex/config.toml`:

```toml
[mcp_servers.texra]
command = "texra"
args = ["mcp", "serve"]
transport = "stdio"
```

`texra mcp serve` is the single most leveraged feature in round 2: it makes every TeXRA agent reusable from every other agent that speaks MCP, without a fork.

### 24.2 Surface

A minimum viable v1 surface — three tools, no resources, no prompts. Resources can come in v1.1 once we know what callers actually want.

| MCP tool name  | Backed by                                               | Purpose                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_workflow` | `executeAgent({ category: "workflow", ... })`           | Run a workflow agent (correct, polish, elevate, devise, criticize, merge, OCR, transcribe). Inputs: `agent`, `inputFile`, `outputFile`, `rounds?`, `model?`, `useMultiple?`. Output: `AgentFlowResult`.                           |
| `run_chat`     | `executeAgent({ category: "toolUse", ... })`            | Run a tool-use agent (orchestrator, devise, search, generic). Inputs: `agent`, `instruction`, `cwd?`, `allowedTools?`, `disallowedTools?`. Output: streaming via `notifications/progress`; final `AgentFlowResult` on completion. |
| `list_agents`  | `getAgentsBySource()` from `@agent/index/agentRegistry` | Returns the agent catalog (id, category, description, source). Lets the calling agent decide what's safe to delegate.                                                                                                             |

All three accept an optional `runId` so the caller can correlate progress notifications. Approval policy is forced to `never` by default in MCP mode (no TTY for prompts) — callers wanting bash/edit auto-approval pass `approvalPolicy: "yolo"` explicitly, exactly as round 1 §9 specifies for headless mode.

### 24.3 Process model

stdio JSON-RPC 2.0, one process per client connection, exactly the Claude Code / Codex pattern. The server lifecycle:

1. `texra mcp serve` boots, calls `initPlatform()` once with a special `McpHostAdapter` (config from `~/.config/texra/`, secrets from keyring, no stdout writes — all output is JSON-RPC framed on stdout).
2. `initialize` request from the MCP client establishes session capabilities and the `progressToken` shape.
3. Each `tools/call` from the client builds a fresh `RunContext` (§22.3) — fresh `progress: McpProgressSink`, fresh `signal: AbortController`, fresh `coordinators`. **This is why §22's singleton retirement gates v1.1 of `texra mcp serve`** — until coordinators are per-context, two concurrent `tools/call`s leak progress between them.
4. `notifications/progress` from the server streams progress events to the client (one notification per `ProgressEvent`). The client's handler decides whether to render them (Claude Code's hook system can route them to a sub-stream tab).
5. On `notifications/cancelled`, the matching run's `signal` is aborted; the run cleans up via existing cooperative-cancel paths.
6. Server exits when stdin closes.

### 24.4 Permission propagation

The MCP client (Claude Code, Codex, etc.) is itself a permission boundary. TeXRA's MCP-server mode trusts the client to have already obtained user approval for the _call_ (e.g., Claude Code asked the user "let texra\_\_run_polish run?"). What TeXRA still owns is what the _agent inside_ TeXRA does — the bash and edit gates inside a `run_chat` orchestrator session.

Three policies for those inner gates, selected by tool argument:

- `approvalPolicy: "never"` (default in MCP mode) — auto-deny inner edits/bash. The orchestrator agent must complete without them or fail. Suitable for trusted reasoning + read-only file inspection.
- `approvalPolicy: "yolo"` — auto-approve inner edits/bash. Caller takes responsibility (the caller is itself an agent that already negotiated permission with its user).
- `approvalPolicy: "ask"` — emit a `notifications/elicitation/create` to ask the caller. Requires MCP Spec 2025-03-26+ elicitation support. v1 ships `never|yolo`; `ask` lands when ecosystem support stabilizes.

### 24.5 v1 vs v1.1 deliverables

**v1.0 ships:**

- `texra mcp serve` subcommand using `@modelcontextprotocol/sdk` (the official TS SDK). ~250 LOC of glue.
- Three tools above.
- `notifications/progress` streaming.
- Cancellation via `notifications/cancelled`.
- Session isolation **only** to the extent the §22.5 v1.0 migration achieves it (per-context coordinators). One concurrent run per process; concurrent calls serialize. Documented limitation.

**v1.1 ships (gated on §22.5 v1.1 migration):**

- True concurrent sessions in one MCP-server process. The audit's singleton-retirement work removes the leak risk.
- Optional MCP `resources` surface exposing `~/.texra/projects/<hash>/<sessionId>.jsonl` (§27) for transcript replay.
- Elicitation-based approvals.

### 24.6 LOC

| Item                                                                           | New      | Modified |
| ------------------------------------------------------------------------------ | -------- | -------- |
| `packages/cli/src/mcp/server.ts` (server bootstrap, capability advertising)    | ~120     | —        |
| `packages/cli/src/mcp/tools/{runWorkflow,runChat,listAgents}.ts`               | ~250     | —        |
| `packages/cli/src/mcp/sinks/McpProgressSink.ts` (also used by Logger v2 §23.3) | ~80      | —        |
| `packages/cli/src/runtime/initPlatform.ts` (McpHostAdapter branch)             | —        | ~30      |
| `packages/cli/src/commands/mcp.ts` (`texra mcp serve`)                         | ~40      | —        |
| **Subtotal**                                                                   | **~490** | **~30**  |

## 25. Hook system (Claude Code-style)

### 25.1 Why now

Hook contracts are easy to bolt on later in theory and a nightmare in practice — every hook event the kernel doesn't fire today is one that consumers can't depend on tomorrow. The survey shows Claude Code's hook event taxonomy is the de facto standard (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`, `Notification`, `PreCompact`, `PostCompact`, `PermissionRequest`). We adopt the same names and the same wire contract; that buys us:

- Users who already have Claude Code hooks can copy them with a one-line `command:` change.
- A `texra` hook can call out to a `claude` hook handler and vice versa with no translation.
- The hook contract — JSON on stdin, JSON or empty on stdout, `exit 2` to block — is dead simple to implement in any language.

### 25.2 Wire contract (verbatim from Claude Code)

```jsonc
// hook input on stdin
{
  "hookEventName": "PreToolUse",
  "session": {
    "id": "ses_abc123",
    "cwd": "/path/to/project",
    "agent": "orchestrator",
  },
  "tool": { "name": "bash", "input": { "command": "rm -rf /" } },
}
```

```jsonc
// hook output on stdout (optional)
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "reason": "rm -rf is not allowed in this project",
  },
}
```

`exit 0` with no stdout = no opinion (continue). `exit 0` with stdout = parsed as a `HookOutput`. `exit 2` = block; stderr is forwarded to the agent as a tool-result error. Other non-zero codes = log a warning, don't block.

### 25.3 Where hooks fire

| Event                        | Fires from                                                                          | RunContext field                                     |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ | ------ | ---------- | -------- |
| `SessionStart`               | `executeAgent.ts` after `buildAgentLaunchContext`                                   | `runId`, `streamId`, `cwd`                           |
| `UserPromptSubmit`           | Tool-use REPL on each user submit                                                   | `runId`, `instruction`                               |
| `PreToolUse`                 | `requestToolEditApproval`, `requestBashApproval`, generic tool dispatch             | `runId`, `tool.name`, `tool.input`                   |
| `PostToolUse`                | Tool dispatch after result                                                          | `runId`, `tool.name`, `tool.result.summary`          |
| `Stop`                       | `executeAgent` finalizer                                                            | `runId`, `result.status`                             |
| `SubagentStop`               | Delegation child completion                                                         | `runId`, `parentStreamId`, `childStreamId`, `result` |
| `Notification`               | Any `requestShowError` / `requestShowInstruction` emission                          | `runId`, `message`                                   |
| `PreCompact` / `PostCompact` | (Future, §32 — context compaction)                                                  | `runId`, `compactionStats`                           |
| `PermissionRequest`          | The same gate `PreToolUse` covers, but specifically for the approval gates §9 lists | Same as `PreToolUse` plus `gate: "edit"              | "bash" | "plan" | "proposal" | "retry"` |

### 25.4 Configuration

`hooks.yaml` under each scope, layered the same way config is (`flag > project > user`). `~/.config/texra/hooks.yaml` for user, `.texra/hooks.yaml` for project, both validated against a Zod schema:

```yaml
# .texra/hooks.yaml
PreToolUse:
  - matcher: { tool: bash }
    handler:
      type: command
      command: ./scripts/audit-bash.sh
      timeoutMs: 5000
  - matcher: { tool: edit, path: 'src/legacy/**' }
    handler:
      type: command
      command: ./scripts/no-legacy-edits.sh

PostToolUse:
  - matcher: { tool: '*' }
    handler:
      type: command
      command: ./scripts/log-tool.sh

SessionStart:
  - handler:
      type: prompt
      append: 'Always cite ArXiv numbers when referencing papers.'
```

Handler types (subset of Claude Code's): `command` (shell), `prompt` (append text to the system prompt), `mcp_tool` (call an MCP tool). `http` and `agent` are deferred — they're nice but not on the critical path.

### 25.5 v1 deliverable

v1.0 ships `command` and `prompt` handlers and the eight events listed above except `Pre/PostCompact`. ~400 LOC, mostly schema validation and the dispatch loop. Each hook runs in a 30s default timeout (configurable per hook). Multi-handler matchers: all run in parallel; any non-zero exit blocks; first-match `permissionDecision` wins.

### 25.6 Why this is in the CLI PRD, not a separate one

Hooks fire from kernel code paths (`executeAgent.ts`, approval coordinators) — which means the kernel needs a `HookHost` interface (shape: `dispatch(event, payload): Promise<HookOutput>`). The extension and the desktop host get hooks for free once the kernel side is wired. That's a kernel pre-refactor (call it C9):

**C9. `HookHost` interface in `core/hosts/hooks.ts`.** _(~60 LOC interface + ~80 LOC dispatcher in core; ~60 LOC of hook-loading + matcher logic in core; ~250 LOC of CLI-side adapter to load `hooks.yaml` and execute commands.)_

The CLI adapter is the only handler-runner v1.0 ships. The extension and desktop hosts can install a no-op `HookHost` at v1.0 and pick up `command`-handler support whenever they want — no kernel work needed.

## 26. Approval policy revisited (no 2D sandbox axis)

### 26.1 Why we're not adopting Codex's matrix

Round 2's first draft proposed adopting Codex's `approval_policy × sandbox_mode` 2D matrix. User feedback: that's too complicated. Round 1's 1D model — `never | ask | auto-edits | auto | yolo` — stays.

The reasons it's the right call:

1. **Codex's `sandbox_mode` solves a problem we don't have.** Codex sandbox modes wrap _all_ agent file/network access in an OS-level sandbox (Seatbelt on macOS, Landlock on Linux). TeXRA today doesn't sandbox — its tools call `executeCommand` (`@utils/system/execUtils`) and `nodeFilesystem` directly. Adding a real OS sandbox is a 4–6 engineering-week project of its own and orthogonal to the CLI shell.
2. **Surface-level "in-project / outside-project" distinction is enough for v1.** Round 1 §9.2 already says "in-project" auto-approves under `auto`/`auto-edits`, "outside-project" prompts. That's where 90% of the value is. The remaining 10% is "I want a true OS sandbox," which the desktop's macOS App Sandbox / Windows AppContainer / Linux unprivileged-namespaces story will eventually solve in a host-uniform way — _not_ a CLI-only knob.
3. **A 2D matrix doubles the test surface and doubles the doc surface.** The mental load — "if I pass `--approval-policy auto --sandbox workspace-write` what happens to bash that touches `/tmp`?" — is exactly the friction users complained about with Codex's first iteration.

### 26.2 What round 2 _does_ sharpen

Round 1 §9.2 says "in-project means the candidate file/cwd is inside the resolved workspace path." Round 2 specifies the predicate concretely so the kernel and the CLI agree:

```ts
// packages/core/src/runtime/approvalPredicates.ts (new — ~40 LOC)
export function isInProject(candidate: string, workspaceRoot: string): boolean {
  const candidateAbs = path.resolve(candidate);
  const rootAbs = path.resolve(workspaceRoot);
  const rel = path.relative(rootAbs, candidateAbs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
```

Edge cases the predicate handles explicitly:

- Symlink resolution: `path.resolve()` does NOT resolve symlinks; we deliberately do not follow them. A symlink inside the project pointing outside is treated as outside-project for approval purposes, which matches user intuition ("a symlink to /etc isn't 'inside my project'").
- Case-insensitive filesystems (macOS HFS+, Windows NTFS): `path.relative` returns the actual case from the filesystem; comparison is exact-string. This is correct — case folding belongs in the filesystem layer, not the policy predicate.
- `cwd === workspaceRoot`: trivially in-project; no separate codepath.
- Files under the workspace's `.git/` directory: in-project by predicate, but flagged with a separate `isInsideHiddenDir` helper that approval handlers check before auto-approving (we never auto-approve writes to `.git/`, period).

### 26.3 Bash command predicate

Bash is harder than file paths — "auto-approve when in-project" doesn't make sense for `rm -rf $HOME`. Round 1 punted on this. Round 2 spec:

- `auto` policy auto-approves bash _only_ when the resolved cwd is in-project AND the command's argv[0] is in a built-in safe list. The safe list is small and conservative: `ls`, `cat`, `head`, `tail`, `wc`, `find` (read-only flags only), `grep`, `rg`, `git status`, `git diff`, `git log`, `pdflatex`, `latexmk`, `pandoc`, `texcount`. Editable per-project via `approval.allowedBash` in config (round 1 §9.4).
- Any redirect to `/`, any unquoted variable, any `&&` / `||` / `|` chain that contains a non-listed command → falls back to `ask` even under `auto`.
- `yolo` short-circuits all of this; `never` always denies.

The argv parser is `shell-quote` (~3 KB, MIT, 30M weekly downloads) — well-trodden territory, no need to write a shell parser.

### 26.4 No new flags, no policy renames

Same vocabulary as round 1 §9.2. Same flags. The §26 work is just the predicate library and ~40 LOC of guard code in `cli/src/approval/policyEngine.ts`. Total: ~80 LOC of new code, ~20 LOC modified.

## 27. Session transcripts — JSONL under project-hash sharding

### 27.1 What today's storage layout looks like

`RunStorageService` (and `executionRegistry.ts`) writes per-execution snapshots to `nodeStorage` workspace storage — the shape is "a directory per execution, files inside." This works for the extension's progress webview (which reads the snapshot to repopulate the tab on reload) but is awkward for a CLI:

- No single file to `tail -f`.
- No `find` query for "all sessions in project X."
- No way to import a session into a new project (project identity is implicit).
- `texra resume <id>` has to reconstruct context from disparate files.

### 27.2 The new layout

Match Claude Code's pattern, with TeXRA's run/stream lineage:

```
~/.texra/projects/
  <projectHash>/                # sha256(absolute cwd), first 16 hex chars
    project.json                # { cwd, agentCategoryDefaults, lastSession }
    sessions/
      <sessionId>.jsonl         # one event per line; round-1 §11.2 schema
      <sessionId>.meta.json     # { createdAt, agent, model, status, duration, parentSession? }
```

`<sessionId>` is `ses_` + 12 hex chars (collision-safe; ULID-like). Project hash is stable across machines because the cwd is normalized (resolved symlinks, lowercased on case-insensitive filesystems, no trailing slash).

### 27.3 What's in the JSONL

Each line is exactly one `LogRecord ∪ ProgressEventPayloads` from §23.4. The first line is a synthetic `event: "session_start"` carrying the `AgentConfigPayload`, the resolved model, the workspace root, and the approval policy. The last line is `event: "session_end"` with `AgentFlowResult`. Everything between is the round-1 §11.2 NDJSON event stream as it happened, with timestamps preserved.

This gives us several wins for free:

- `texra run ... --output-format ndjson > out.ndjson` and the on-disk transcript are byte-for-byte the same data shape (modulo the synthetic start/end markers). Tools that parse one parse the other.
- Replay: `cat <sessionId>.jsonl | jq -c .` is a debug session.
- Compaction (§32): a `texra session compact <id>` subcommand can rewrite the JSONL with summarized turns; the schema knows what's safe to drop.

### 27.4 `texra resume` semantics

```
texra resume                           # interactive picker over recent sessions in cwd's project
texra resume <id>                      # resume that specific session
texra run --continue                   # most recent session in cwd's project
texra run --fork-session <id>          # branch from <id>; creates new sessionId, copies context up to fork point
```

`--continue` is shorthand for `texra resume <last>`; `--fork-session` matches Claude Code's verb. The runtime side is the existing `resumeToolUseFromSnapshot()` — but it now takes a `sessionId` and reads the JSONL up to the last `session_end` (or the end of file for a still-active session).

### 27.5 Migration

The existing `~/.texra/global-storage/<workspace>/runs/` layout stays for one release; an entry-point shim translates legacy reads. New sessions write to the new layout. ~80 LOC of migration code; ~120 LOC of writer + reader.

### 27.6 LOC

| Item                                                                                         | New      | Modified |
| -------------------------------------------------------------------------------------------- | -------- | -------- |
| `packages/core/src/storage/sessionStore.ts` (new — JSONL writer + reader, project-hash util) | ~200     | —        |
| `packages/core/src/storage/sessionMigration.ts` (legacy → new)                               | ~80      | —        |
| `cli/src/commands/resume.ts` (consumes sessionStore directly)                                | —        | ~30      |
| `cli/src/commands/run.ts` (`--continue`, `--fork-session` flags)                             | —        | ~20      |
| **Subtotal**                                                                                 | **~280** | **~50**  |

## 28. GitHub Action revisited — composite + Bun, not JS

### 28.1 Why round 1's JS Action pick was wrong

Round 1 §6 #9 picked JS Action ("warm-cached and faster than Docker for this use case"). The survey shows `claude-code-base-action` actually ships as a **composite action** that shells out via `bun run ${GITHUB_ACTION_PATH}/src/index.ts`. The reasons that's the right pick — and round 1 missed them:

1. **No `dist/` checked into the action repo.** JS Actions require a bundled `dist/index.js` committed to the repo (because GitHub Actions runners only download the `action.yml` + the repo contents, not run `npm install`). Composite actions can install dependencies at action-run time, which means the action repo holds source, not bundles, and PRs are reviewable.
2. **Faster iteration.** A composite action can pin a specific CLI version (`npm install -g @texra/cli@x.y.z`) per release without re-bundling. JS Actions need a release-cut process every CLI release.
3. **Bun caches the install.** The runner's `actions/cache` key on `~/.bun/install/global` makes repeat runs near-instant, matching JS Action's warm-cache claim.
4. **Composite + `runs.using: composite`** lets us stitch multiple steps (cache restore → install → run → upload artifacts) without a Node entrypoint that has to do all of those itself.

### 28.2 Revised action shape

```yaml
# texra-ai/texra-base-action/action.yml
name: TeXRA Base Action
description: Run a TeXRA agent on inputs in your repository.
inputs:
  agent: { description: 'Agent name (polish, elevate, …)', required: true }
  input: { description: 'Input file path', required: false }
  output: { description: 'Output file path', required: false }
  rounds: { description: 'Workflow rounds', required: false, default: '1' }
  model: { description: 'Model name', required: false }
  approval-policy:
    { description: 'never|ask|auto-edits|auto|yolo', default: 'never' }
  texra-version: { description: 'Pinned CLI version', default: 'latest' }
  output-format: { description: 'text|json|ndjson', default: 'ndjson' }
outputs:
  status: { description: 'completed|failed|cancelled' }
  output-files: { description: 'JSON array of output file paths' }
  session-id: { description: 'Session id for resume' }
  execution-file: { description: 'Path to NDJSON transcript on the runner' }
runs:
  using: composite
  steps:
    - name: Cache TeXRA CLI
      id: cache-cli
      uses: actions/cache@v4
      with:
        path: |
          ~/.bun/install/global
          ~/.npm
        key: texra-cli-${{ runner.os }}-${{ inputs.texra-version }}

    - name: Install TeXRA CLI
      if: steps.cache-cli.outputs.cache-hit != 'true'
      shell: bash
      run: npm install -g @texra/cli@${{ inputs.texra-version }}

    - name: Run TeXRA
      id: run
      shell: bash
      env:
        TEXRA_OUTPUT_FORMAT: ${{ inputs.output-format }}
      run: |
        texra run "${{ inputs.agent }}" \
          ${{ inputs.input && format('--input "{0}"', inputs.input) || '' }} \
          ${{ inputs.output && format('--output "{0}"', inputs.output) || '' }} \
          --rounds "${{ inputs.rounds }}" \
          ${{ inputs.model && format('--model "{0}"', inputs.model) || '' }} \
          --approval-policy "${{ inputs.approval-policy }}" \
          --output-format "${{ inputs.output-format }}" \
          | tee texra-transcript.ndjson

        # Parse final summary line for outputs
        summary=$(tail -1 texra-transcript.ndjson)
        echo "status=$(echo "$summary" | jq -r .status)" >> "$GITHUB_OUTPUT"
        echo "output-files=$(echo "$summary" | jq -c .outputs)" >> "$GITHUB_OUTPUT"
        echo "session-id=$(echo "$summary" | jq -r .meta.sessionId)" >> "$GITHUB_OUTPUT"
        echo "execution-file=texra-transcript.ndjson" >> "$GITHUB_OUTPUT"

    - name: Upload transcript
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: texra-transcript-${{ inputs.agent }}
        path: texra-transcript.ndjson
        retention-days: 7
```

~80 lines of YAML; no JS to write at all for the base action. The high-level `texra-action` (§12.2) still has logic — trigger detection, PR comment posting, optional commit-back — and stays a TS-source composite action that runs `bun run src/index.ts` for that logic.

### 28.3 Cold-start measurements (target)

- First run on a fresh runner: `npm install -g @texra/cli` ≈ 12s + first `texra run` ≈ 4s = ~16s overhead before the model call.
- Cached run: `actions/cache` hit ≈ 1s + `texra run` ≈ 4s = ~5s overhead.
- JS Action equivalent: ~3s (no install) + ~4s = ~7s. The composite is +2s on the warm path and -∞ on the iteration path (no bundle re-cuts needed).

### 28.4 Updated round-1 §6 decision

| #   | Concern       | Round 1 pick | Round 2 pick                                                        |
| --- | ------------- | ------------ | ------------------------------------------------------------------- |
| 9   | GitHub Action | JS Action    | **Composite action + Bun runner; install CLI from npm at run time** |

No other round-1 picks change.

## 29. Cross-platform shared structure (kernel-side refactor)

### 29.1 Today's shape

The pnpm workspace has three packages skeletoned (`packages/{core,extension,desktop}`) with the kernel still living at root `src/`. Round 1 §7.1 assumed Electron Phase 0 finishes the kernel migration and the CLI is the fourth peer. Round 2 sharpens what "the kernel" means and where the per-host seams go — because the audit revealed three categories of shared code that today live mixed together.

### 29.2 Three layers under `packages/core/`

The kernel splits cleanly into three concentric rings; each ring has a different host-coupling rule.

**Ring 1: pure logic** (zero host coupling, zero ALS).

- `core/agent/` minus runtime — every modelHandler, every flow, every node, every reasoning strategy.
- `core/model/`, `core/latex/`, `core/replacement/`, `core/eventBus/` (schemas only — no emitters).
- `core/tools/` minus `core/tools/approval/`.
- `core/shared/` — IPC schemas, `runStream.ts` (§23.4).

These take a `RunContext` argument (post-§22) but never reach for the ambient store. Test harnesses pass a synthesized `RunContext` and never need a fake host.

**Ring 2: runtime orchestration** (consumes `RunContext`; no `vscode`/`electron`/`process` access).

- `core/runtime/` — `RunContext`, `Logger`, `ProgressSink` interface, `executeAgent`, all coordinators.
- `core/tools/approval/` — gates and controllers.
- `core/auth/` — `SupabaseSessionCoordinator`, `TierService`, `ServerSideKeyService` (post-§22.5 per-context).
- `core/hosts/` — every host port (`PromptHost`, `ExternalOpener`, `DiffViewHost`, `TerminalHost`, `ClipboardHost`, plus the new `HookHost` from §25.6).
- `core/storage/sessionStore.ts` (§27.6).

These import from Ring 1 freely, and they accept host services through their constructor / `RunContext` — but they never `import 'vscode'`, never `import 'electron'`, never `process.exit`.

**Ring 3: platform defaults** (Node-only; no `vscode`/`electron`).

- `core/platform/defaults/` — today's `consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets`. CLI uses 5 of 6; desktop uses similar set; extension uses none.

These are the shared concrete impls that any Node host gets for free. Adding a new Node-based host (e.g. a `texra serve` daemon, or a future Tauri-based app) should require only Ring 3 + a thin host adapter — no Ring 1 or Ring 2 changes.

### 29.3 What lives in `packages/{extension,desktop,cli}/`

Per-host code is everything that imports a host SDK or interacts with a host's surface. Crisp rule: **the host package's `src/` is allowed to import `vscode` / `electron` / `commander` / Ink, and nothing under `core/` is**.

| Host      | Owns                                                                                                                            | Doesn't own                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Extension | `vscode.commands`, webview hosts, `frontend/vscode/*`, controllers wired to webview message handlers, `VscodeOutputChannelSink` | The agent runtime (in core); coordinators (in core) |
| Desktop   | Electron `main`, preload bridges, BrowserWindow lifecycle, `electronLogSink`, packaging                                         | Same                                                |
| CLI       | `commander` parsing, Ink TUI, `texra mcp serve`, `StderrTextSink`, `NdjsonStdoutSink`, hook command-runner                      | Same                                                |

### 29.4 The host-port catalog (consolidated)

Round 1 §4.1 lists the host ports already landed (`PromptHost`, `ExternalOpener`, etc.). Round 2 adds:

| Port           | Added in | Implementations                                                                                                     |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `LogSink`      | §23.2    | `VscodeOutputChannelSink`, `electronLogSink`, `StderrTextSink`, `NdjsonStdoutSink`, `McpProgressSink`, `MemorySink` |
| `HookHost`     | §25.6    | `CommandHookHost` (CLI), `NoopHookHost` (extension/desktop v1.0)                                                    |
| `SessionStore` | §27.6    | `JsonlSessionStore` (shared across all Node hosts; extension uses storage path under `globalStorageUri`)            |

All ports live in `packages/core/src/hosts/`. The `Platform` interface from `src/platform/platform.ts` stays the same — those are the _infrastructure_ services (config, fs, secrets); ports are the _interaction_ services. They're not the same thing and they should not merge.

### 29.5 What this saves

The refactor isn't free — it's ~150 LOC of `index.ts` re-exports + ESLint rules + a few moves. What it buys:

- **A new host needs only the rings it cares about.** A future Tauri app: import Ring 1 + Ring 2 + a Tauri-specific Ring 3 (`tauriFilesystem`, `tauriSecrets`); zero extension or CLI code touched.
- **Tests don't fake hosts to test logic.** Ring 1 has no host. The kernel's existing FakePlatform suite stays in Ring 2 and only exercises Ring 2 code paths.
- **Webview vs CLI vs Electron diff is a wiring diff, not a behavior diff.** When `polish` rewrites a paragraph differently in the CLI than the extension, we have one place to look (Ring 1 + the agent's YAML), not three.

### 29.6 LOC

| Item                                                                                                  | New     | Modified              | Deleted |
| ----------------------------------------------------------------------------------------------------- | ------- | --------------------- | ------- |
| Reorg of `packages/core/src/` into `agent/` (R1), `runtime/` (R2), `platform/` (R3) — mostly `git mv` | —       | ~10 (re-export files) | —       |
| ESLint `no-cross-ring-imports` rule                                                                   | ~40     | —                     | —       |
| `core/hosts/index.ts` re-export catalog                                                               | ~30     | —                     | —       |
| `core/runtime/index.ts` re-export                                                                     | ~20     | —                     | —       |
| **Subtotal**                                                                                          | **~90** | **~10**               | —       |

Mostly mechanical; no rewrites of business logic.

## 30. Container & GitHub-runner target matrix

### 30.1 Survey-driven revisions

Round 1 §12.3 listed five containers as "verified to run." The survey turns up two corrections:

1. **`node:20-alpine` is best-effort, not first-class.** Alpine's musl libc breaks `@napi-rs/keyring` prebuilds (we already plan to fall back to file-based secrets there). It also breaks Bun's prebuilt binaries — relevant if a user wants to run `texra mcp serve` from Bun rather than Node. We document Alpine as supported only with the file-secrets fallback and Node-only execution.
2. **`node:20-bookworm-slim` is the recommended Linux image.** Glibc, smallish (~80 MB before TeXRA), and `apt-get install libsecret-1-0` for keyring is one line.

### 30.2 Updated matrix

| Image / runner                                       | Tier        | Notes                                                                                 |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `ubuntu-22.04` (default GitHub runner)               | First-class | Node 20 preinstalled. CI matrix runs full E2E here.                                   |
| `ubuntu-24.04`                                       | First-class | Same. Recommended once GHA's default flips.                                           |
| `macos-14` (GitHub-hosted M-series)                  | First-class | E2E runs here for keyring path coverage.                                              |
| `windows-latest`                                     | First-class | E2E runs here for path-handling coverage.                                             |
| `node:20-bookworm-slim`                              | First-class | Recommended self-hosted/container. ~80 MB.                                            |
| `node:20-bookworm`                                   | First-class | Same plus build tools. ~150 MB.                                                       |
| `texlive/texlive:latest`                             | First-class | TeXRA's primary integration container. Adds Node 20 via `apt-get install nodejs npm`. |
| `mcr.microsoft.com/devcontainers/typescript-node:20` | First-class | Dev container; smoke-tested in Phase 0.                                               |
| `node:20-alpine`                                     | Best-effort | Keyring fallback to file. Bun unavailable. Documented in §10.3.                       |
| `gitpod/workspace-full`                              | Best-effort | Smoke-tested but not in CI matrix.                                                    |

### 30.3 Local-development "callable from Claude Code / Codex" verification

The survey-driven user goal — "callable by Claude code and codex etc" — is verified in CI by an integration test:

- A GitHub Actions job spawns a fresh runner.
- Installs `@anthropic-ai/claude-code` + `@texra/cli`.
- Writes `.mcp.json` pointing at `texra mcp serve`.
- Runs `claude --print "list the workflow agents available via texra"` in headless mode.
- Asserts the response mentions at least three TeXRA workflow agent names.

The same test pattern with `@openai/codex` covers the Codex path. ~120 LOC of test, runs once per PR. Cost: ~$0.03 per run (a few thousand tokens). Catches regressions in the MCP wire contract specifically — the surface most likely to silently rot because no human-in-the-loop session exercises it.

### 30.4 Where-does-the-CLI-write-files matrix

To make GitHub-Actions ephemerality explicit (and prevent secrets leaking via uploaded artifacts), every file path the CLI writes is documented with a default and an env override:

| Concern             | Default (linux)                                | Env override       | Allowed in CI artifact upload?                                                                   |
| ------------------- | ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| Config              | `~/.config/texra/config.yaml`                  | `TEXRA_CONFIG_DIR` | No — may contain endpoint URLs.                                                                  |
| Secrets fallback    | `~/.texra/secrets.json` (chmod 0600)           | `TEXRA_DATA_DIR`   | **Never** — explicit gitignore + `.actignore` patterns.                                          |
| Session JSONL       | `~/.texra/projects/<hash>/sessions/<id>.jsonl` | `TEXRA_DATA_DIR`   | Yes if `--allow-session-upload` (false by default). Inputs/outputs are paths, not content; safe. |
| Runtime cache       | `~/.cache/texra/`                              | `TEXRA_CACHE_DIR`  | Yes; non-sensitive (downloaded model schemas, agent registry).                                   |
| Logs (`--log-file`) | User-specified                                 | —                  | User-controlled — they pick.                                                                     |

Documented as `texra config path` output for fast diagnosis from `texra doctor`.

## 31. Round 2 — phase plan delta and aggregate LOC

### 31.1 Phase plan delta vs round 1 §15

Round 2 adds new work into existing phases plus one new phase (Phase 1.5) for the MCP-server surface. Phases 0, 2, 3, 4, 5 from round 1 keep their scope; Phase 1 absorbs §22 + §23 + §26 (all kernel-side, all on the critical path for tool-use agents).

| Phase     | Round-1 scope                        | Round-2 additions                                                                  |
| --------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 0         | Workspace + headless workflow runner | + `RunContext` shim + Ring 1/2/3 reorg (§22.5 pre-v1, §29)                         |
| 1         | Tool-use + approval engine           | + per-context coordinators (§22.5 v1.0) + Logger v2 (§23) + bash predicate (§26.3) |
| 1.5 (new) | —                                    | `texra mcp serve` v1.0 surface (§24.5) + integration test (§30.3)                  |
| 2         | Config + secrets + auth              | unchanged                                                                          |
| 3         | Interactive REPL                     | unchanged                                                                          |
| 4         | GitHub Action                        | composite-action revision (§28)                                                    |
| 5         | Polish, docs                         | + JSONL session migration (§27.5) + hook system v1 (§25.5)                         |

### 31.2 Aggregate LOC

| Bucket                                  | Round-1 net      | Round-2 additions                                                                                                                                                                         | Round-2 total    |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `packages/cli/`                         | 2,800–3,800      | +730 (MCP §24.6, hooks adapter §25, sessions §27.6, sandbox-removed §26 ≈ 0)                                                                                                              | **3,530–4,530**  |
| `packages/core/` (CLI pre-refactors)    | ~730             | +940 (RunContext §22 net ~+170, Logger v2 §23 ~+430, HookHost §25.6 ~+140, sessionStore §27.6 ~+200, ring re-exports §29.6 ~+90, approval predicates §26 ~+80, minus overlap with Logger) | **~1,670**       |
| `texra-ai/texra-action` (separate repo) | ~800             | -300 (no JS shim; YAML composite + small TS for the high-level action only)                                                                                                               | **~500**         |
| **Total v1**                            | **~4,330–5,330** | **+~1,370**                                                                                                                                                                               | **~5,700–6,700** |

The round-2 work expands the project by ~30%, but ~70% of the addition is in the kernel — work that the extension and the desktop app inherit unchanged. The CLI shell still finishes in the same ballpark (3.5–4.5 KLOC). v1 ships in **~9–11 weeks** for a single engineer, **~6–8** for two engineers (Phases 0 + 1 sequential, 1.5 + 2 parallel, 3 sequential, 4 + 5 parallel).

### 31.3 Updated success criteria (additive to §17)

- `texra mcp serve` is callable from Claude Code with default `.mcp.json` config; the integration test in §30.3 passes on every PR.
- `RunContext` is the only path through which kernel code accesses progress / log / signal / approval. The ESLint `no-ambient-runtime-state` rule has zero exceptions in `packages/core/src/agent/`, `core/tools/`, `core/auth/` after v1.3.
- A user can `texra run polish ...` from inside `texlive/texlive:latest` with only `npm install -g @texra/cli` and `ANTHROPIC_API_KEY` set — no extra setup, no other binaries.
- Session JSONL transcripts are byte-equivalent to `--output-format ndjson` output (modulo the synthetic `session_start`/`session_end` markers).

## 32. Parking lot — out of v1 scope (sized for visibility)

Items the user surfaced or round-2 research uncovered as "would be nice but not urgent." Sized so the team can pick them up without re-discovering scope.

### 32.1 Unified agent-SDK / message-SDK with conversation compaction

User's words: "It would be nice we have a unifying agent SDK or message SDK with compactization etc but that is no rush."

**Sketch:**

A `core/messages/` ring sitting between Ring 1 and Ring 2: typed message envelope (`UserMessage | AssistantMessage | ToolCall | ToolResult | SystemNote`), compaction policies (`KeepAll`, `SlidingWindow(N)`, `SummarizeOldest(N)`, `TokenBudget(N)`), and a `Conversation` abstraction that all model handlers consume instead of building their own array of provider-shaped messages. Today every modelHandler in `src/agent/modelHandlers/` builds its own message array; the differences are mostly cosmetic. Compaction would hook into `PreCompact` / `PostCompact` events from §25.

**Why not v1:**

- Compaction policies are agent-specific (an OCR agent's "drop oldest message" is different from an orchestrator's). Designing the API right requires usage data we don't yet have.
- Provider message shapes diverge subtly (Anthropic's vs OpenAI's vs Gemini's tool-result envelopes) — a unifying SDK either picks one and translates, or invents a new shape; both are 4–6 engineering weeks of design.
- Round 1's existing `executeAgent` surface is enough for the CLI to ship.

**Tracking:** v2.0 work; new PRD when there's a concrete proposal.

### 32.2 OS-level sandbox on agent execution

Codex's `seatbelt` / `landlock` model. Round 2 §26.1 declines for v1 because it's orthogonal to the CLI shell. Tracking issue when the desktop app's macOS-App-Sandbox / Windows-AppContainer story wants to converge with a CLI-side equivalent.

### 32.3 `texra serve` long-lived daemon

Round 1 §18.1. Same shape as opencode's HTTP server. Sized at ~800 LOC if it shares §27's session store + §24's RunContext. v1.x or v2.

### 32.4 MCP resources surface (not just tools)

Round 1 §18 lists `texra mcp serve` as v1.1; round 2 promotes the `tools` half but not `resources`. Resources would expose session JSONL transcripts and agent definitions as MCP resources (callers can `resources/read` to import them). ~150 LOC; depends on what calling agents actually want.

### 32.5 Replay / cost guards / pipeline-as-code

Round 1 §18.1 listed all three. Unchanged.

### 32.6 Hooks: HTTP and `agent` handlers

Round 2 ships only `command` and `prompt` handler types in §25.5. `http` (POST to a webhook) and `agent` (call back into a TeXRA agent) handlers are 80–120 LOC each and should land when there's a concrete user request — building them speculatively risks getting the contract wrong.

---

End of round 2. The CLI is still a thin Node shell over a host-neutral kernel; round 2 just makes the kernel honestly host-neutral (no ambient singletons), bigger in the right direction (RunContext + Logger v2 + HookHost + SessionStore are kernel-shared infra), and _callable by every other agent that speaks MCP_ — which was the user's framing all along.
