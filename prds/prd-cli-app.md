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

| Concern                                                                          | Status today                                                                                                                                                                                                                                                                                                                                                                   | CLI impact                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentRuntimeHost` / `ProgressSink` boundary (Electron PRD §9 #20)               | **Landed.** `executeAgent()` accepts an optional `runtimeHost` on `ExecuteAgentOptions`; resolution uses `AsyncLocalStorage` (`runWithAgentRuntimeHost`) with a process-global default fallback. No `ProgressEventBus` singleton import in agent code.                                                                                                                         | CLI calls `setDefaultAgentRuntimeHost()` once at startup with its own `ProgressSink` (writes to stdout / stderr / JSON stream). ~80 LOC.                                                                          |
| Expanded `ConfigProvider` (`update`/`inspect`/`isExplicitlySet`/`watch`) (§9 #1) | **Landed.** All four methods on `src/platform/interfaces/config.ts`.                                                                                                                                                                                                                                                                                                           | CLI implements `ConfConfigProvider` against `conf` (or a layered YAML reader). ~100–120 LOC.                                                                                                                      |
| `WorkspaceProvider.watch()` (§9 #4)                                              | **Landed.** `nodeWorkspace` already implements `watch()` with recursive `fs.watch` + fallback.                                                                                                                                                                                                                                                                                 | Reused as-is. CLI batch mode never calls `watch()`; interactive mode does.                                                                                                                                        |
| `vscode.EventEmitter` → Node `EventEmitter` (§9 #3)                              | **Landed.**                                                                                                                                                                                                                                                                                                                                                                    | No CLI work.                                                                                                                                                                                                      |
| `SupabaseSession` + `TokenProvider` extraction (§9 #14)                          | **Landed.** `SupabaseSessionCoordinator` is host-neutral and `implements AuthTokenProvider`; storage backend is pluggable.                                                                                                                                                                                                                                                     | CLI provides a file-backed `SupabaseSessionStorage` (`~/.texra/session.json`, chmod 600) and wires the device-code / loopback flow into the existing coordinator. ~150 LOC.                                       |
| Narrow UI ports (§9 #18)                                                         | **Landed.** `PromptHost` / `ExternalOpener` / `DiffViewHost` / `TerminalHost` / `ClipboardHost` all live in `src/hosts/`. The host-neutral _controllers_ are split per-domain under `src/controllers/{mainView,progressView,settingsView}/` (multiple controllers per domain — e.g. `MainViewInteractionController`, `MainViewStartupController`, `MainViewStatusController`). | CLI does **not** mount the controllers (they're webview-shaped, one method per renderer message). It calls `executeAgent()` directly. The narrow UI ports (`PromptHost` especially) are reused by approval flows. |
| `BinaryResolver` for `pdflatex`/`pandoc`/`gm`/Codex (§9 #8)                      | **Landed.** `findToolInCommonPaths()` + `findCodexBinaryPath()` already check Homebrew / TeX Live / MikTeX / global npm / PATH.                                                                                                                                                                                                                                                | Reused. The Electron-only `app.asar.unpacked` resolution branch is dead code in CLI; everything else works.                                                                                                       |
| `AgentDirectories` resource sync (§9 #19)                                        | **Partially landed.** The `AgentDirectories` interface + `setAgentDirectories()` injection point exist in `src/agent/index/agentRegistry.ts`; the bootstrap/sync logic still lives in `src/frontend/agents/AgentDirectoryManager.ts` and still imports `vscode`.                                                                                                               | CLI needs the bootstrap moved into the host-agnostic class (Electron PRD #19's full scope). Listed as a CLI pre-refactor in §14 C0.                                                                               |
| Default Node platform impls                                                      | **Landed.** `consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets` (`src/platform/defaults/`, ~462 LOC). All carry the comment "for CLI / Electron / tests".                                                                                                                                                                              | 5 of 6 used as-is; `EnvSecrets` is replaced by the CLI's keyring-backed `PlatformSecrets`.                                                                                                                        |
| `vscode`-import audit                                                            | Same 106-of-853 (12.4%) as the Electron PRD reports. None of the 106 are reachable from `executeAgent()`.                                                                                                                                                                                                                                                                      | Confirmed by walking the call graph from `executeAgent.ts:674` — all transitive imports are in the agnostic zones.                                                                                                |

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

Electron Phase 0 will establish a three-package pnpm workspace (`core`, `extension`, `desktop`). The CLI is the fourth peer in that target layout:

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
| `agent/index/`              | `resolveAgent`, `getAgent`, `AgentDirectoryManager`, `AgentDirectories` (post-#19)                                                                                                      |
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
- `core/controllers/` — `MainViewController` / `ProgressViewController` / `SettingsViewController` are webview-shaped (one method per renderer message). CLI calls `executeAgent()` directly. The narrow UI ports from §9 #18 (`PromptHost`, `ExternalOpener`) _are_ used.

### 7.3 Platform impls (CLI)

The seven wired services (six `Platform` interfaces plus `PlatformSecrets`) need ~250 LOC of new adapter code (`ConfConfigProvider` + `KeyringSecrets`); the other five reuse the existing `src/platform/defaults/` impls byte-for-byte.

| Interface                | Extension (today)                                                  | Electron (planned)                                   | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigProvider`         | `VscodeConfigProvider` (wraps `vscode.workspace.getConfiguration`) | `ConfConfigProvider` over `conf` (Electron PRD §6.1) | **Same `ConfConfigProvider`**, lifted to `@texra/core` so both CLI and Electron share it. Layer: defaults from Zod schema → user file (`~/.config/texra/config.yaml`) → project file (`.texra/config.yaml` discovered upward) → env (`TEXRA_*`) → flags. Inspect returns the layered view.                                                                                                                                                                                                                    |
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

Internally `runAgent` builds an `AgentConfigPayload` (agent + model + file fields), calls `setDefaultAgentRuntimeHost()` if not already wired, then calls `executeAgent(payload, undefined, { runtimeHost, onProgress, onStreamResolved, … })` from core. The `ProgressSink` on `runtimeHost` forwards each kernel event to the user's `onProgress`; types come from `@shared/schemas` so consumers get the same Zod-validated union the kernel emits. Total surface: ~300 LOC of facade + re-exports.

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

Calls `resolveAgent()` / `getAgent()` / `AgentDirectoryManager.listAgents()`. Lists are output-format-aware so `texra agents list -o json | jq '.[] | select(.category=="workflow")'` works in scripts.

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
- `package.json` `"exports"`:
  ```json
  {
    ".": "./dist/bin/texra.js",
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

**C0. Finish the host-agnostic `AgentDirectories` move (Electron PRD §9 #19).** _(~150 LOC: ~80 LOC moved into `core/agents/`, ~50 LOC of VS Code wrapper, ~20 LOC of CLI wrapper.)_

The `AgentDirectories` interface and `setAgentDirectories()` injection point already exist in `src/agent/index/agentRegistry.ts`. The bootstrap/sync logic (copy bundled YAMLs into per-host writable storage on version bumps) still lives in `src/frontend/agents/AgentDirectoryManager.ts` and still imports `vscode`. Without finishing the move, the CLI either ships its own bootstrap (drift) or violates the agnostic-zone rule. **Why now:** same risk shape as the Codex resolution bug — works in dev because file paths happen to resolve, fails on a fresh `~/.texra/` if bootstrap never runs.

**C1. CLI-facing approval handler interface.** _(~80 LOC.)_

The current `setToolEditApprovalHandler()` accepts a single function. The CLI installs _its own_ function, but the function reaches inside `request` to render a unified diff and prompt. We add a tiny helper in `core/tools/approval/` that exposes a `formatUnifiedDiff(left, right)` utility (re-using the existing `diff-match-patch` semantic-diff path) so the CLI's handler doesn't reimplement diff formatting. **Why now:** without it the CLI ships its own diff library, and we end up with two diff implementations going out of sync. Tiny addition; avoids drift.

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
- `AgentDirectories` resource sync (§9 #19) — interface landed; bootstrap still in `frontend/`. Treated as a CLI pre-refactor in §14 C0 above. Once it lands, the CLI's bundle source is `node_modules/@texra/core/dist/resources/` and user storage is `~/.texra/agents/`.

### Suggested ordering

C0 → C2 → C1 → C3 → C4 → C6 → C7 → (C5 in parallel, since it's server-side) → C8.

If everything lands together, ~1.5 engineering weeks.

## 15. Migration phases

Each phase is independently reviewable. The extension and the desktop port never break during this work — every change is additive. Phases 0 and 1 can run in parallel with the Electron PRD's Phase 2 (renderer + main view), since they touch different packages.

### Phase 0 — Workspace package + headless workflow runner (1.5 weeks)

**Gates:** Electron PRD's Phase 0 (monorepo split) must be merged. §14 C0 (`AgentDirectories` bootstrap moved out of `frontend/`) must be merged so a fresh `~/.texra/` populates built-in agents on first launch. CLI lives at `packages/cli/` from the start.

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

| Item                                                     | Net new                        | Modified                        |
| -------------------------------------------------------- | ------------------------------ | ------------------------------- |
| §14 C0 (`AgentDirectories` bootstrap move)               | ~70 (core) + ~20 (CLI wrapper) | ~50 (extension wrapper rewrite) |
| §14 C1 (approval helper)                                 | ~80                            | —                               |
| §14 C2 (XDG paths in `nodeStorage`)                      | ~30                            | ~10                             |
| §14 C3 (`ClackPromptHost`)                               | ~80                            | —                               |
| §14 C4 (`ApprovalPolicy` type)                           | ~40                            | —                               |
| §14 C5 (Supabase device-code edge function + CLI client) | ~200 (server) + ~50 (CLI)      | —                               |
| §14 C6 (`listActiveRuns()`)                              | ~30                            | —                               |
| §14 C7 (bundle-size guard CI script)                     | ~20                            | —                               |
| §14 C8 (JSON schema docs)                                | ~200 (markdown)                | —                               |
| **Subtotal core/extension/server**                       | **~820**                       | **~60**                         |

#### Aggregate budget

| Bucket                                                   | Net new LOC      | Modified LOC | Total touched    |
| -------------------------------------------------------- | ---------------- | ------------ | ---------------- |
| `packages/cli/`                                          | 2,800–3,800      | ~160         | ~2,960–3,960     |
| `packages/core/` + extension wrapper (CLI pre-refactors) | ~820             | ~60          | ~880             |
| `texra-ai/texra-action` (separate repo)                  | ~800             | —            | ~800             |
| **Total v1**                                             | **~4,420–5,420** | **~220**     | **~4,640–5,640** |

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
