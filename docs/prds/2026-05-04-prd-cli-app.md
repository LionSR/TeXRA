---
created: 2026-05-04
updated: 2026-06-07
---

# PRD: TeXRA CLI

**Status:** Draft (v1 — grounded in codebase scout + ecosystem survey, May 2026)
**Owner:** TBD
**Date:** 2026-05-03
**Branch:** `claude/texra-cli-electron-prd-AXNBu`
**Companion to:** [`2026-05-02-prd-electron-app.md`](./2026-05-02-prd-electron-app.md)

## 1. Summary

Ship TeXRA as a third host — `texra`, a stand-alone command-line tool — alongside the VS Code extension and the planned Electron desktop app. The CLI runs the same agent core that the other two hosts run, with two consumption modes:

1. **Headless / batch mode** (`texra run …`, `--print`, `--output-format json`) — non-interactive, exit-code-driven, suitable for shell pipelines, GitHub Actions, dev containers, and any CI/CD environment that just wants `input.tex → output.tex` (or a tool-use agent run with pre-approved tool calls).
2. **Interactive mode** (`texra` with no args, or `texra chat`) — Codex-CLI / Claude-Code-style terminal UI for orchestrator and other tool-use agents, with TTY-aware prompts for edit / bash / plan approvals.

Both modes import `@texra/core` unchanged. The CLI shell is pure Node, ESM-first, with no `vscode` and no `electron` dependency. No webviews are needed. Net-new code lives in a fourth pnpm workspace at `packages/cli/`.

Per a parallel scout of the runtime, almost every blocker the Electron PRD's §9 Tier 1 identified for the desktop port has already landed (see §4.1 for the audit). The CLI's runtime cost is therefore _not_ "extract a kernel from VS Code coupling" — that work is paid for. The CLI cost is "wire the (already-clean) kernel to a Node entry point, a TTY renderer, an approval policy engine, and a small auth flow."

The agent core ships with Node-friendly platform defaults already explicitly tagged "for CLI / Electron / tests" (`consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets`). Of the 6 default impls in `src/platform/defaults/`, the CLI **reuses 5 byte-for-byte** and replaces `EnvSecrets` with a keyring-backed adapter so personal API keys and OAuth tokens persist across invocations; it also adds a file-backed `ConfigProvider` adapter (~180 LOC combined). The CLI is fundamentally a thin Node shell over an already-headless kernel.

(Throughout this PRD, `@texra/core` references the kernel package created by the Electron PRD's Phase 0 monorepo split — the kernel currently lives in `src/`. CLI Phase 0 inherits the split or ships against `src/` aliases unchanged; the import surface is identical.)

### 1.1 Implementation note, 2026-05-11

The first CLI/run-context/logger stack implements the conservative part of this PRD without claiming the full v1 surface:

- `texra run` is wired through the shared `executeAgent()` path and has packaged binary validation in PR #3843.
- CLI approval policy handling and serialized terminal prompts are implemented in PR #3844.
- `texra chat` has a plain terminal loop in PR #3846. This is the fallback input mode described below, not the final rich renderer.
- Rich chat rendering, inline approval cards, grouped tool-display modes, and session metadata remain follow-up work tracked by #3848.
- Tool-context reader separation for `src/tools` is implemented in PR #3847: the active context is async-scoped, narrow run/call views are stored separately, and tool readers now use run-owned, call-owned, or explicit mixed access paths instead of the combined compatibility getter. The remaining architectural question is whether `ToolRunContext` becomes part of `RunContext`, remains an ALS-backed shim, or is passed explicitly at the tool execution boundary.

This note is here to keep the PRD readable for third-party reviewers: the PRD describes the intended v1 shape, while the current stack lands the smallest coherent subset and records the rest as owned follow-up issues.

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
| Narrow UI ports (§9 #18)                                                         | **Landed.** `PromptHost` / `ExternalOpener` / `DiffViewHost` / `TerminalHost` / `ClipboardHost` all live in `src/hosts/`. The host-neutral _controllers_ are split per-domain under `src/controllers/{mainView,progressView,settingsView}/` (multiple controllers per domain — e.g. `MainViewStartupController`, `MainViewExecutionController`, `ProgressFollowUpController`).                                                    | CLI does **not** mount the controllers (they're webview-shaped, one method per renderer message). It calls `executeAgent()` directly. The narrow UI ports (`PromptHost` especially) are reused by approval flows.                                                                                                                                                                                                          |
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
| Proposal bypass (YOLO)      | `proposalApprovalState.toggleBypass`, per-stream                    | Pure state                                 | CLI exposes via `--yolo` / `--allow-delegation` flags                    |

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
- OpenTUI-based TUI when the Node/npm distribution proof is satisfied; otherwise a Node-stable renderer behind the same chat boundary. Top pane: live agent stream (assistant text, tool calls, tool results), with the same in-place updates the desktop progress view shows. Middle pane: the active todo list, plan, or pending approval card. Bottom pane: input prompt with multi-line editor (Ctrl-J for newline, Enter to submit, Ctrl-C to interrupt the active run, Ctrl-D to exit).
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
| 2   | Interactive TUI        | **OpenTUI preferred; Node-stable fallback if distribution proof fails**                                                                              | OpenTUI fits agent chat layout and code/diff rendering, but it must prove Node 20+ npm installation before becoming a hard dependency.                       |
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
- `core/controllers/` — the per-domain controllers under `src/controllers/{mainView,progressView,settingsView}/` (e.g. `MainViewStartupController`, `MainViewExecutionController`, `ProgressFollowUpController`, `ProgressStreamLifecycleController`, `SettingsAgentCatalogController`, `SettingsMemoryController`, …) are webview-shaped (one method per renderer message). CLI calls `executeAgent()` directly. The narrow UI ports from §9 #18 (`PromptHost`, `ExternalOpener`) _are_ used.

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

**Caveat (today's runtime shape):** `executeAgent`'s `runtimeHost` is optional and falls back through `AsyncLocalStorage` to a process-global default set by `setDefaultAgentRuntimeHost()`. Two SDK callers in the same process can therefore step on each other's defaults, and approval handlers (`setToolEditApprovalHandler`, `bashApprovalController`) are also module-level singletons. The SDK as specified here is honest about that boundary: it is safe for one consumer per process at v1. Concurrent in-process embedding is gated on [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md) Phase 0 + 1 (RunContext threading + coordinator retirement, ~2.5 weeks); not v1 scope. Phase 2+ of that PRD (full sink/host retirement) is the prerequisite for the post-v1 `texra mcp serve` feature, not for the v1 CLI.

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

**Non-goal — do not unify the approval gates during this work.** The repo today has four approval shapes (`BasePromiseCoordinator` for plan/proposal/retry; `streamApprovalQueue` + `bashApproval.ts`; `streamApprovalQueue` + `toolEditApproval.ts` with `customHandler` injection; `awaitExternalInquiryResponse`). The fragmentation is real but it encodes a real domain difference — bash approval is a permission gate, edit approval is a diff/merge workflow with file I/O, three-way patch reconciliation, line-change tracking, and per-tool rejection results (`toolEditApproval.ts:135-372`). Collapsing them into a shared `BasePromiseCoordinator` subclass relocates ~250 LOC into the new subclass without removing it, and forces the base class to absorb edit-only concerns (post-result enrichment, file write, diff compute). The CLI just registers its own handlers against the existing seams. If unification is ever right, it's a separate refactor with its own justification — not a side-effect of CLI work.

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
4. Waits for the browser callback; `parseAuthCallbackCode()` from `src/auth/authCallback.ts` extracts the query-based PKCE authorization code.
5. Hands the code to the host-neutral session coordinator, which exchanges it for a session and retains the existing refresh, expiry, and custom-endpoint behavior.

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

Lazy-loaded only when `selectMode() === 'interactive'`. ~600 LOC of `.tsx` components in `cli/src/render/ink/`.

**Design baselines (commit before writing components).** TeXRA's webview already has a mature inline chat UI (`packages/extension/src/progressView/frontend/`); the TUI should mirror, not invent. Four constraints:

- **Wrap `render`/`createRoot` with auto-injected ThemeProvider.** Components import only from `cli/src/render/ink/index.ts`, never directly from `'ink'`. The wrapper module re-exports themed `Box`, `Text`, and the `render`/`createRoot` functions wrapped with `<ThemeProvider>` (CC's `src/ink.ts` pattern, ~30 LOC). Eliminates "did I mount the theme provider?" footguns and locks the theme contract at one site.
- **Polymorphic `<ApprovalCard>` dispatching on `permission.kind`.** One card component switches on `TOOL_EDIT | BASH | PLAN_APPROVAL | PROPOSAL | RETRY | EXTERNAL_INQUIRY` to a per-kind subcomponent — direct mirror of the webview's `PermissionCard.ts` (499 LOC) and its `BaseFeedbackPanel` y/n/escape contract. The keystroke contract, the per-card `handleExtraKey` extension point, and the bypass-state-per-stream model are already proven; reuse the shape.
- **Hot/cold context split for streaming updates.** The webview uses `streamLogContext` to isolate per-chunk updates from cold UI (`packages/extension/src/progressView/frontend/streamContexts.ts`). Mirror this in the TUI but tighter — three contexts segregated by update cadence: `logsContext` (hot, every chunk), `lifecycleContext` (`taskGroups`, `streamStatus`), `renderConfigContext` (cold: `streamName`, `terminalMode`, `isToolUse`). The webview's existing context leaks cold fields into the hot path; the TUI is the chance to do this right from day one.
- **Virtualize, don't `<Static>`/`<Box>`.** TeXRA's content is dense LaTeX (often 1,000–2,000 lines per response), not chat-shaped. Use Ink's ScrollBox + viewport-based virtual list. CC's `<Static />` workaround (`src/utils/staticRender.tsx:8-10`: writes JSX directly to stdout to bypass Ink's reflow) is a workaround for chat-density content; we don't need it. Plan for stable scroll anchoring during streaming.

**Components:**

- `<App />` — top-level layout. Owns the keybinding registry; subcomponents register via `useKeybinding(action, handler)` (CC's mixed pattern: raw `useInput` only here, registered keybindings everywhere else).
- `<StreamPane />` — virtualized stream output via ScrollBox + viewport rendering. Renders the same event types as the webview's `progressView`, but as text + ASCII glyphs.
- `<TodoList />` — renders `plan` / `todo_write` state updates as a checkbox list.
- `<ApprovalCard />` — polymorphic per `permission.kind` (above). Takes focus until resolved.
- `<PromptInput />` — multiline input with history (Ctrl-R search), slash-command completion, paste-friendly (Shift-Enter for explicit newline).

Ink + React ship as a separate chunk (~150 KB minified). The headless renderer never imports them. `import('@texra/cli/ink')` is dynamic and gated on `selectMode()`.

### 11.4 Non-goal: do not co-locate tool render with tool definition

CC's pattern of attaching React render components to each tool (e.g. `BashTool/UI.tsx`) is wrong for TeXRA. TeXRA's render layer is generic-by-type, not per-tool: `formatters/logFormatters/toolFormatters.ts` (960 LOC) dispatches on `ctx.toolName` and field shape (`old_str`/`new_str` triggers diff render, `command` triggers bash render), and shared helpers like `buildEditDiffSection` are reused across `edit_file`, `memory`, and others. Co-locating render into `src/tools/<name>/` would force each tool to export a per-host renderer (Lit + Ink), duplicate the shared helpers, and inflate the surface from ~1,300 centralized LOC to ~7,300 scattered LOC. The CLI's renderer mirrors the existing dispatcher pattern: a `cli/src/render/ink/toolRenderers/` directory with one file per _render shape_ (diff-input, terminal-output, file-list, plan, etc.) — not per tool.

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

**C1. Stderr unified-diff renderer in the CLI shell.** _(~80 LOC, CLI-only — not a core pre-refactor.)_

The CLI's edit-approval handler renders a textual diff before prompting. The repo already has the diff math: `src/agent/output/diffComputation.ts` (`computeOutputDiffStats`) computes stats; `packages/extension/src/progressView/frontend/formatters/wordDiff.ts` (`generateInlineDiff`) produces word-level diffs. The CLI handler reuses these functions and adds a thin renderer in `cli/src/render/diff.ts` that emits picocolors-formatted unified-diff text to stderr — _only the rendering target_ differs from the webview path. No new helper in core; no new dependency. **Removed from the previous draft:** the proposal to add `formatUnifiedDiff` to `src/agent/output/diffComputation.ts` — it would duplicate existing capability and introduce a third diff surface.

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
- **Exit criteria:** `texra run orchestrator --instruction "..." --approval-policy yolo` runs an end-to-end multi-tool flow against a real LaTeX project. `--approval-policy never` denies the gate and returns the denial to the model as feedback (exit code 4 was retired in 2026-08). Approvals on TTY render diffs and respect user input.

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

**Estimated timeline (single engineer):** 8–9 weeks (sum of phase ranges: 1.5 + 1.5–2 + 1–1.5 + 2 + 1 + 1). With a two-engineer team running Phase 1 + Phase 2 in parallel after Phase 0, achievable in 5.5–7 weeks.

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

| Metric                                                          | Value                                                                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total TS files in `src/` (today, pre-monorepo-split)            | 853                                                                                                                                                                          |
| Files importing `vscode` reachable from `executeAgent()`        | **0**                                                                                                                                                                        |
| Platform interface LOC                                          | ~470                                                                                                                                                                         |
| Existing Node-default platform impls (`src/platform/defaults/`) | ~462 LOC across 6 files                                                                                                                                                      |
| Of which CLI reuses byte-for-byte                               | 5 of 6 (`consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`); `EnvSecrets` is replaced by `KeyringSecrets`                                         |
| New CLI-side platform adapters needed                           | 2 (`ConfConfigProvider`, `KeyringSecrets`) at ~180 LOC combined                                                                                                              |
| Tool surfaces fully reused (no CLI shim)                        | 14 of the 16 listed in §4.2 (every entry except the 2 explicitly marked as needing a CLI handler)                                                                            |
| Approval gates fully host-neutral today                         | 5 of 7 (3 standalone `BasePromiseCoordinator`s — plan, proposal, retry — plus the `awaitExternalInquiryResponse` event pattern and the `proposalApprovalState` state toggle) |
| Approval gates needing CLI-specific settle path                 | 2 of 7 (edit, bash — both have host-neutral controllers; the _handler_ is what's host-specific)                                                                              |
| Approval gates needing CLI-specific handler                     | 2 (edit, bash)                                                                                                                                                               |
| Pre-refactorings still required in `core/`                      | 6 small items (~430 LOC + a server-side edge function)                                                                                                                       |

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

| Delta | Round 1 status | Round 2 position | New § |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| Explicit `RunContext` replaces ambient ALS + singletons (§7.6 caveat / #3397) | Tracked as future work | **Promoted to standalone PRD — see [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md). CLI v1.0 consumes Phase 1; v1.1 consumes Phase 2 (gates concurrent MCP sessions).** | §22 (stub) |
| Structured logger with explicit context, no module globals | Hand-waved as "consoleLog plus filter wrapper" | **Promoted to standalone PRD — see [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md). CLI installs four sinks (stderr text, NDJSON stdout, Ink, MCP).** | §23 (stub) |
| `texra mcp serve` (callable from Claude Code, Codex, opencode) | Listed as v1.1 future | **Promoted to v1; minimum surface = three tools (`run_workflow`, `run_chat`, `list_agents`)** | §24 |
| Hook system (SessionStart, PreToolUse, PostToolUse, …) | Not mentioned | **v1.1 — copy Claude Code's contract verbatim; spec'd here so v1 doesn't paint itself into a corner** | §25 |
| Approval policy revisited (no 2D sandbox axis) | 1D `never                                            | ask                                                                                                                                                                                                        | auto-edits | auto | yolo` | **Stays 1D per user feedback. Round 2 sharpens the "in-project / outside-project" semantics with concrete file:line rules.** | §26 |
| Session transcripts as JSONL under project-hash sharding | Implicit reuse of `RunStorageService` snapshot files | **Explicit format; `texra resume` / `--continue` / `--fork-session` semantics** | §27 |
| GitHub Action: composite + Bun (not JS Action) | §12 picked JS Action | **Reverse — match `claude-code-base-action`'s composite pattern; faster iteration, no `dist/` checked in** | §28 |
| Cross-platform shared structure refactor (kernel side) | Implicit | **Promoted into [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md) §8 (three-ring kernel structure). CLI-side consumption details retained here.** | §29 (stub) |
| Container / GitHub-runner target matrix (slim, alpine, texlive) | Sketched in §12.3 | **Refined per survey; `node:20-alpine` is downgraded to "best-effort" because of glibc/Bun/native-deps issues** | §30 |
| Phase plan delta + LOC delta | — | **Aggregated** | §31 |
| Parking lot — unified agent-SDK / message-SDK / context compaction | — | **Out of v1; sized in §32 for visibility** | §32 |

The rest of round 2 is the spec for these deltas, in dependency order: §22 → §23 unblock §24 (an MCP server can't safely host concurrent sessions until the kernel's ambient state is gone); §24 + §25 + §26 are independent hosts on the new context; §27 + §28 + §29 + §30 are deployment / packaging concerns that don't gate kernel work.

## 22. RunContext — replace ambient ALS + singletons → see [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md)

§22 has been promoted to a standalone PRD because the work is kernel-shaped, benefits all three hosts (extension, desktop, CLI), and is not a CLI-specific concern. See [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md) for the full design — the inventory of ambient state, the `RunContext` interface, the migration shim, the phased deletion of singletons, and the three-ring `packages/core/` structure (which previously lived in §29 of this PRD and is now §8 of the RunContext PRD).

### 22.1 What the CLI consumes

The CLI's relationship to the RunContext PRD is one of _consumer_, not _driver_:

- The CLI's `cli/src/runtime/initPlatform.ts` constructs a `RunContext` per `texra run` invocation, populates `RunCapabilities` (no extension; GitHub token from `process.env.GITHUB_TOKEN` or `process.env.GH_TOKEN`; no callback resolver), and threads it via `withRunContext(ctx, () => executeAgent(...))`.
- The CLI's `texra mcp serve` host (§24) constructs _one `RunContext` per MCP `tools/call`_ — that's the workload that gates the RunContext PRD's Phase 2 (singleton retirement) for v1.1 concurrency safety.
- Until the RunContext PRD's Phase 1 lands, the CLI's `runAgent()` SDK is documented as **single-consumer-per-process** (round-1 §7.6 caveat). The shim path makes this safe-by-default, not safe-by-design.

### 22.2 Phase mapping

| RunContext-PRD phase                               | Lands in CLI release | What the CLI gains                                                                                           |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Phase 0 (foundations)                              | CLI v1.0 prereq      | `withRunContext` wraps every `runAgent()` SDK call; `tryUseRunContext()` available to CLI sinks.             |
| Phase 1 (per-context coordinators)                 | CLI v1.0             | Plan / proposal / retry approvals route through the CLI's TTY prompt handler without singleton interference. |
| Phase 2 (sink + runtime-host singleton retirement) | CLI v1.1             | `texra mcp serve` hosts concurrent sessions safely.                                                          |
| Phase 3 (capability injection)                     | CLI v1.2             | `--use-my-keys`, `--no-tier-check`, GitHub token CI flow stop relying on module setters.                     |
| Phase 4 (auth singletons)                          | CLI v1.2             | Multi-account testing in CI no longer needs process restart between tests.                                   |
| Phase 5 (sweep)                                    | CLI v1.3             | `texra` cold-start drops by ~5ms (no fallback chains in hot paths).                                          |

### 22.3 LOC accounting (CLI side only)

| Item                                                                     | New                 | Modified |
| ------------------------------------------------------------------------ | ------------------- | -------- |
| `cli/src/runtime/initPlatform.ts` constructs `RunContext` per invocation | ~60                 | —        |
| Per-`tools/call` `RunContext` factory in `cli/src/mcp/server.ts`         | (counted under §24) | —        |
| Test harness updates to `withRunContext`-wrap all CLI tests              | —                   | ~50      |
| **Subtotal (CLI side)**                                                  | **~60**             | **~50**  |

The kernel work is sized in `2026-05-06-prd-runcontext-refactor.md` §7 (~6.5 engineering weeks across Phases 0–5).

## 23. Logger v2 — structured records, host sinks → see [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md)

§23 has been promoted to a standalone PRD for the same reason as §22 — the work is kernel-shaped infrastructure, not CLI-specific. See [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md) for the design: the `Logger` / `LogRecord` / `LogSink` interfaces, the `BootstrapLogger`, schema unification with the round-1 §11.2 NDJSON event stream, per-host sink mapping, and the phased migration off `src/logger/logUtils.ts` and the `outputChannelFactory` module global.

### 23.1 What the CLI installs

| Mode | Sink | What it does |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Headless text (`--print` or non-TTY) | `StderrTextSink` | picocolors-formatted; respects `--quiet` / `--verbose` / `NO_COLOR`; copies to `--log-file` if passed. |
| JSON / NDJSON (`--output-format json | ndjson`) | `NdjsonStdoutSink` | One `RunStreamEvent` per line on stdout (the same union the §11.2 progress stream uses). |
| Interactive (Ink TUI) | `InkLogSink` | Routes records to the `<StreamPane />` component as `event === "log"` rows alongside progress events. |
| MCP server (`texra mcp serve`) | `McpProgressSink` | Records become `notifications/progress` payloads bound to the request's progress token. |

All four CLI-side sinks live in `packages/cli/src/render/sinks/`. `BootstrapLogger` is constructed in `cli/src/bin/texra.ts` immediately and threaded through config-load, secret resolution, agent-directory bootstrap, and mode selection — its buffer flushes through whichever sink the resolved mode picks.

### 23.2 LOC accounting (CLI side only)

| Item                                                                             | New      |
| -------------------------------------------------------------------------------- | -------- |
| `StderrTextSink` (picocolors-aware)                                              | ~120     |
| `NdjsonStdoutSink` (schema-validated)                                            | ~60      |
| `InkLogSink` (Ink-component-aware; lazy chunk)                                   | ~80      |
| `McpProgressSink` (counted under §24)                                            | (— )     |
| Bootstrap wiring in `cli/src/bin/texra.ts` and `cli/src/runtime/initPlatform.ts` | ~30      |
| **Subtotal (CLI side)**                                                          | **~290** |

The kernel work is sized in `2026-05-06-prd-logger-v2.md` §9 (~3.8 engineering weeks across Phases 0–5).

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

The MCP client (Claude Code, Codex, etc.) is itself a permission boundary. TeXRA's MCP-server mode trusts the client to have already obtained user approval for the _call_ (e.g., Claude Code asked the user "let texra\_\_run*polish run?"). What TeXRA still owns is what the \_agent inside* TeXRA does — the bash and edit gates inside a `run_chat` orchestrator session.

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
- Session isolation **only** to the extent `2026-05-06-prd-runcontext-refactor.md` Phase 1 achieves it (per-context coordinators). One concurrent run per process; concurrent calls serialize. Documented limitation.

**v1.1 ships (gated on `2026-05-06-prd-runcontext-refactor.md` Phase 2 — singleton retirement):**

- True concurrent sessions in one MCP-server process. The audit's singleton-retirement work removes the leak risk.
- Optional MCP `resources` surface exposing `~/.texra/projects/<hash>/<sessionId>.jsonl` (§27) for transcript replay.
- Elicitation-based approvals.

### 24.6 LOC

| Item                                                                                                                | New      | Modified |
| ------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| `packages/cli/src/mcp/server.ts` (server bootstrap, capability advertising)                                         | ~120     | —        |
| `packages/cli/src/mcp/tools/{runWorkflow,runChat,listAgents}.ts`                                                    | ~250     | —        |
| `packages/cli/src/mcp/sinks/McpProgressSink.ts` (also used by Logger v2; see `2026-05-06-prd-logger-v2.md` Phase 5) | ~80      | —        |
| `packages/cli/src/runtime/initPlatform.ts` (McpHostAdapter branch)                                                  | —        | ~30      |
| `packages/cli/src/commands/mcp.ts` (`texra mcp serve`)                                                              | ~40      | —        |
| **Subtotal**                                                                                                        | **~490** | **~30**  |

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

| Event | Fires from | RunContext field |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ | ------ | ---------- | -------- |
| `SessionStart` | `executeAgent.ts` after `buildAgentLaunchContext` | `runId`, `streamId`, `cwd` |
| `UserPromptSubmit` | Tool-use REPL on each user submit | `runId`, `instruction` |
| `PreToolUse` | `requestToolEditApproval`, `requestBashApproval`, generic tool dispatch | `runId`, `tool.name`, `tool.input` |
| `PostToolUse` | Tool dispatch after result | `runId`, `tool.name`, `tool.result.summary` |
| `Stop` | `executeAgent` finalizer | `runId`, `result.status` |
| `SubagentStop` | Delegation child completion | `runId`, `parentStreamId`, `childStreamId`, `result` |
| `Notification` | Any `requestShowError` / `requestShowInstruction` emission | `runId`, `message` |
| `PreCompact` / `PostCompact` | (Future, §32 — context compaction) | `runId`, `compactionStats` |
| `PermissionRequest` | The same gate `PreToolUse` covers, but specifically for the approval gates §9 lists | Same as `PreToolUse` plus `gate: "edit"              | "bash" | "plan" | "proposal" | "retry"` |

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

Each line is exactly one `RunStreamEvent` from `2026-05-06-prd-logger-v2.md` §6 (the union of `LogRecord` and `ProgressEventPayloads`). The first line is a synthetic `event: "session_start"` carrying the `AgentConfigPayload`, the resolved model, the workspace root, and the approval policy. The last line is `event: "session_end"` with `AgentFlowResult`. Everything between is the round-1 §11.2 NDJSON event stream as it happened, with timestamps preserved.

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

## 29. Cross-platform shared structure → see [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md) §8

The CLI is purely a _consumer_ of the three-ring structure: imports Rings 1 + 2 + 3 from `packages/core/` plus its own deps (`commander`, `ink`, `@modelcontextprotocol/sdk`, `@clack/prompts`, `picocolors`, `log-update`, `ora`); contributes nothing into the rings (CLI-side platform adapters `ConfConfigProvider` and `KeyringSecrets` from §7.3 live in the CLI package, not Ring 3). Cross-host imports (CLI → extension, CLI → desktop) are forbidden by the same ESLint rule that scopes `vscode` / `electron` to the extension and desktop packages.

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

| Phase     | Round-1 scope                        | Round-2 additions                                                                                                                                            |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | Workspace + headless workflow runner | + `RunContext` shim (`2026-05-06-prd-runcontext-refactor.md` Phase 0) + Ring 1/2/3 reorg (`2026-05-06-prd-runcontext-refactor.md` §8)                        |
| 1         | Tool-use + approval engine           | + per-context coordinators (`2026-05-06-prd-runcontext-refactor.md` Phase 1) + Logger v2 (`2026-05-06-prd-logger-v2.md` Phases 0–1) + bash predicate (§26.3) |
| 1.5 (new) | —                                    | `texra mcp serve` v1.0 surface (§24.5) + Logger MCP sink (`2026-05-06-prd-logger-v2.md` Phase 5) + integration test (§30.3)                                  |
| 2         | Config + secrets + auth              | unchanged                                                                                                                                                    |
| 3         | Interactive REPL                     | unchanged                                                                                                                                                    |
| 4         | GitHub Action                        | composite-action revision (§28)                                                                                                                              |
| 5         | Polish, docs                         | + JSONL session migration (§27.5) + hook system v1 (§25.5)                                                                                                   |

### 31.2 Aggregate LOC

After the §22/§23/§29 split into dedicated kernel PRDs, the CLI PRD's LOC accounting only counts CLI-package work. Kernel-side LOC is tracked in those PRDs.

| Bucket                                                             | Round-1 net      | Round-2 additions (CLI-only after split)                                                                                                                           | Round-2 total    |
| ------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `packages/cli/`                                                    | 2,800–3,800      | +730 (round-2 CLI-package work: MCP §24, hooks adapter §25, session writer §27.6) + ~350 (CLI-side RunContext + Logger sinks + bootstrap wiring, per §§22.3, 23.2) | **~3,880–4,880** |
| `packages/core/` (CLI's _own_ pre-refactors only — C1–C8 from §14) | ~730             | +220 (HookHost §25.6, sessionStore §27.6, approval predicates §26 — minus the items moved to dedicated PRDs)                                                       | **~950**         |
| `texra-ai/texra-action` (separate repo)                            | ~800             | -300 (no JS shim; YAML composite + small TS for the high-level action only)                                                                                        | **~500**         |
| **Total v1 (this PRD's scope)**                                    | **~4,330–5,330** | **+~1,000**                                                                                                                                                        | **~5,330–6,330** |

Kernel work that the CLI consumes but does not own (sized in the linked PRDs):

| PRD                                                                                | Kernel net new                  | Engineering weeks |
| ---------------------------------------------------------------------------------- | ------------------------------- | ----------------- |
| [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md) | ~-10 (refactor pays for itself) | ~6.5              |
| [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md)                     | ~+310                           | ~3.8              |

CLI v1.0 consumes RunContext Phase 1 + Logger Phase 1; CLI v1.1 consumes RunContext Phase 2 + Logger Phase 5. Both kernel PRDs land alongside CLI Phase 0–1 on the engineering plan. v1 of the CLI ships in **~9–11 weeks** for a single engineer, **~6–8** for two engineers running CLI + kernel work in parallel.

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

---

## 33. Round 3 — minimum-viable v1.0 (2026-05-08)

> **Superseded by §34 (round 4)** on the Ink-vs-MCP ordering: round 4 ships the interactive REPL (Ink) in v1.0 and defers `texra mcp serve` to v1.1, reversing this round. The §33.2 deferral table below is still accurate for every row _except_ the `texra chat` Ink REPL row and the `texra mcp serve` row — those two flip in §34.2. For the canonical current v1.0 plan, read §34.

User feedback after rounds 1 and 2: the scope is too large. Round 3 trims v1.0 to the two highest-leverage features and explicitly defers the rest. Rounds 1 and 2 stay as the long-range design; round 3 is what ships first.

### 33.1 What v1.0 ships

Two features plus minimum plumbing.

**1. `texra run <workflow-agent>` headless** (~1,000 LOC; covers Phase 0 of round 1 §15)

- Workflow agents only: `polish`, `correct`, `elevate`, `devise`, `criticize`, `merge`, OCR, transcribe.
- Env-var auth only — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. (existing `lookupApiKey` resolution path; no keyring, no OAuth).
- `--output-format text|ndjson`. In `text` mode (default): final output file path on stdout, progress on stderr. In `ndjson` mode: structured events on stdout (progress events per §11.2; log records per `2026-05-06-prd-logger-v2.md` §5.2 — the two share transport but version independently per logger §15.1), human messages and errors on stderr.
- Reuses all 6 existing Node platform defaults byte-for-byte (`consoleLog`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `memoryState` — exporting `createMemoryStore()` — and `EnvSecrets`). v1.0 keeps `EnvSecrets` since auth is env-vars-only; the keyring-backed replacement (round 1 §7.3) lands in v1.2.
- No interactive features. No approval engine — workflow agents don't trigger edit/bash gates.
- Exit codes per round 1 §5.1.

**2. `texra mcp serve`** (~500 LOC; covers round 2 §24.5 v1.0)

- Three MCP tools: `run_workflow`, `run_chat` (with `approvalPolicy: "never" | "yolo"` only), `list_agents`.
- stdio JSON-RPC 2.0; one process per client connection.
- `notifications/progress` streaming.
- Cancellation via `notifications/cancelled`.
- Documented v1.0 limitation: one concurrent `tools/call` per process; concurrent calls serialize. Singleton retirement (per `2026-05-06-prd-runcontext-refactor.md` Phase 2) gates true concurrency in v1.1.

This is the leverage feature. It makes every TeXRA agent callable from Claude Code, Codex, opencode, Cursor, and any future MCP host without TeXRA writing its own TUI. Users get an interactive surface for free via the calling host's UI.

**3. Discovery + plumbing** (~150 LOC)

- `texra agents list [--source builtin|custom|remote] [--output-format text|json]`
- `texra models list [--provider <name>] [--output-format text|json]`
- `texra version`, `texra --help`.

**Total v1.0: ~1,650 LOC, ~3 weeks for one engineer.** Down from round 2's ~5,330–6,330 LOC v1 bundle.

### 33.2 What v1.0 explicitly does NOT ship

| Round 1+2 item                                                     | Defer to     | Why it can wait                                                                                   |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| `texra chat` Ink REPL (round 1 §5.2 / §11.3)                       | v1.1+        | MCP server gives users an interactive surface via the calling host's UI. May never need our own.  |
| Tool-use headless with `auto-edits` / `auto` / `ask` (§9.2)        | v1.1         | Only `never` and `yolo` are useful headlessly; both are exposed via MCP `run_chat`.               |
| OAuth loopback + device-code (round 1 §10)                         | v1.2         | Env vars cover ~95% of users (CI, scripts, dev containers).                                       |
| Keyring + file-secrets fallback (§10.3)                            | v1.2         | Env vars + a `--api-key` flag cover the gap.                                                      |
| `conf` + Zod layered config (§6.1, §8.4)                           | v1.2         | Env vars + flags are enough until users complain.                                                 |
| `texra-base-action` GitHub Action (§12, round 2 §28)               | v1.2         | Users `npm install -g @texra/cli` in a workflow step today.                                       |
| `texra resume` / session JSONL (round 2 §27)                       | v1.2         | Workflow agents are stateless; tool-use sessions live in the MCP client's transcript (see §33.4). |
| Hook system (round 2 §25)                                          | v2           | Speculative. Wait for concrete user requests.                                                     |
| `texra doctor` (§8.5)                                              | nice-to-have | ~80 LOC whenever; not blocking v1.0.                                                              |
| Self-contained Bun binaries (§13.3)                                | nice-to-have | Convenience artifact, never the canonical install path.                                           |
| `RunContext` Phase 2 (per `2026-05-06-prd-runcontext-refactor.md`) | v1.1         | Required for _concurrent_ MCP sessions; not for the documented one-call-at-a-time v1.0.           |
| Logger v2 Phase 2 (schema unification with progress)               | cut          | Over-couples slow-changing progress events to fast-changing log records (see logger PRD §15.1).   |
| Logger v2 Phase 5 (`McpProgressSink`)                              | v1.1         | Gated on RunContext Phase 2 anyway.                                                               |

### 33.3 On Ink

Round 1 §6 #2 picked Ink for the interactive REPL. Ink is the right pick _when_ `texra chat` ships — Claude Code, Codex, and Gemini CLI all use it.

But **Ink is only needed for the REPL.** Headless `texra run` is plain stdout / NDJSON; `texra mcp serve` is JSON-RPC framed on stdio. Neither touches Ink.

- v1.0 ships _no_ REPL → no Ink dependency at all → cold start <80ms, no React in the install, smaller npm package.
- v1.1 may ship `texra chat` → Ink as a lazy chunk per round 1 §11.3 is the correct call.
- The MCP-server route may make `texra chat` redundant. A user wanting an interactive TeXRA experience runs `claude` (or `codex`, or `cursor`) with `texra mcp serve` configured; the calling host's TUI is already best-in-class. Building our own competes with that for no clear win.

### 33.4 Sessions and resume — round 3 position

Round 2 §27 specifies a JSONL session store under `~/.texra/projects/<hash>/sessions/<id>.jsonl` matching Claude Code's layout. Round 3 keeps the _layout_ but defers _implementation_ to v1.2:

- v1.0's workflow agents are stateless — input file → output file. No session to resume.
- v1.0's `texra mcp serve` runs inside an MCP client (Claude Code, Codex, …) whose own transcript is the canonical "conversation" record. The client's `--continue` / `--resume` resumes that conversation; TeXRA's contribution shows up there as `texra__run_polish` tool calls + their results.
- Cross-tool resume (resuming a Codex session in Claude Code, or a Claude Code session in TeXRA) **does not exist** in the ecosystem as of May 2026. Each tool's JSONL contains tool-call shapes specific to that tool's runtime; transcripts are interpretable across tools but not executable. The shared on-disk _layout_ (project-hashed JSONL directories, per `cc-sessions` and similar tooling) is the right interop level.

When `texra resume` lands in v1.2, matching Claude Code's directory layout buys ecosystem-tooling reuse for free; the _event schema_ stays TeXRA-specific.

### 33.5 Logger v2 — round 3 consumes a trimmed subset

Logger v2's direction is right, but the v1.0 CLI consumes a trimmed subset (see [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md) §15 for full revisions):

- **Phase 2 cut** (schema unification) — share NDJSON transport, version log/progress schemas independently.
- **Phase 5 deferred** to v1.1 (MCP sink, gated on RunContext Phase 2).
- **Boot logger** is `swapSink()` instead of `flushTo()` — no record reordering, no overflow cap.
- **Channel** auto-derived from `RunContext.streamId`, not pushed at every legacy call site.

Net: logger v2 timeline drops from ~3.8 to ~2.7 engineering weeks for v1.0 scope (Phases 0/1/3, with `InkLogSink` rolled into Phase 1).

### 33.6 Phase plan (v1.0)

| Phase     | Scope                                                                                                                                       | Weeks |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A         | Workspace package + `texra run <workflow-agent>` + headless renderer (text + NDJSON) + `agents list` + `models list` + `version` + `--help` | 1.5   |
| B         | `texra mcp serve` v1.0 (three tools, stdio JSON-RPC, progress notifications, cancellation)                                                  | 1     |
| C         | Polish: release scripting, `npm publish`, README quickstart                                                                                 | 0.5   |
| **Total** | **~3 weeks single-engineer**                                                                                                                | **3** |

Phases A and B are independent after the workspace skeleton lands; two engineers run them in parallel for ~2-week delivery.

### 33.7 Success criteria for v1.0

- `npm install -g @texra/cli && texra run polish --input paper.tex --output paper.polished.tex` succeeds end-to-end with only `ANTHROPIC_API_KEY` set. No prior TeXRA install required.
- `texra mcp serve` is callable from Claude Code with a default `.mcp.json` config; the user can prompt Claude Code to "ask texra to polish this paragraph" and get a result.
- `texra agents list -o json | jq` parses; the schema matches `@shared/schemas`.
- Cold start `texra --help` < 100 ms.
- No regression in extension or desktop builds.

### 33.8 What round 3 does NOT change

Round 1's architecture (§7), platform impls (§7.3), code-reuse boundary (§7.2), repo layout (§7.1), and tech-stack picks (§6 picks 1, 3, 4, 5, 8, 10) all stand. Round 2's MCP-server design (§24) ships _as-is_ — it was already the right shape. Round 3 is purely a scope trim, not a redesign.

The goal of round 3: ship a useful CLI in three weeks, not a complete CLI in three months. The complete CLI is rounds 1 + 2; v1.1, v1.2, and v2 cover everything else as user demand reveals what's worth the cost.

---

## 34. Round 4 — interactive + workflow first, MCP defers (2026-05-08)

User direction after round 3: **MCP can wait. Make interactive and workflow agents work first.** Round 4 reverses round 3's "MCP before REPL" priority — the user wants TeXRA to be a usable, standalone CLI on its own before being a callable backend for other CLIs.

This means Ink ships in v1.0 (round 3 §33.3 said no Ink). The MCP server moves out of the v1.x roadmap entirely (see §34.6). The design goal is also to stay maximally coherent with the existing extension + Electron hosts: the CLI should be another thin host over the shared kernel, not a parallel product with its own semantics.

### 34.1 What v1.0 ships (revised from §33.1)

Three features. Same plumbing.

**1. `texra run <workflow-agent>` headless** (~1,000 LOC; unchanged from §33.1)

- Workflow agents: `polish`, `correct`, `elevate`, `devise`, `criticize`, `merge`, OCR, transcribe.
- Env-var auth, `--output-format text|ndjson`, exit codes per round 1 §5.1.
- Reuses all 6 existing Node platform defaults byte-for-byte: `consoleLog`, `nodeFilesystem`, `nodeStorage`,
  `nodeWorkspace`, `createMemoryStore()` from `memoryState`, and `EnvSecrets`.
- Same kernel contracts as extension + desktop: `executeAgent`, `RunContext`, logger v2, approval hooks, and
  shared Zod schemas stay the source of truth. The CLI contributes a host shell, not a forked agent runtime.

**2. `texra chat` interactive REPL** (~1,400–1,700 LOC; covers round 1 Phase 1 + Phase 3 minimum)

- Ink-based TUI: `<App />`, `<StreamPane />`, `<ApprovalCard />`, `<PromptInput />`. Round 1 §11.3 also lists `<TodoList />` — deferred (lands when `/plan` does; not on the v1.1 list — see §34.7). Ink stays a lazy chunk per round 1 §11.3 — `texra run` headless does not load it.
- Tool-use agents: orchestrator (default), devise, search, generic chat. `--agent <name>` overrides.
- Approval policy: `never | ask | yolo` only (skip `auto-edits` / `auto` for v1.0 — they need the in-project predicate from round 2 §26.3, fine to add in v1.1).
  - `ask` is the default in interactive mode; renders `<ApprovalCard />` inline for edit / bash / plan gates.
  - `never` and `yolo` work in interactive mode for users who want zero-prompt or all-prompt runs.
- Slash commands (subset of round 1 §5.2): `/agent`, `/model`, `/yolo`, `/clear`, `/exit`. `/plan` and `/resume` deferred (no session store yet, no `<TodoList />` yet).
- Multi-line input: Enter to submit, Shift-Enter (or Ctrl-J) for newline, Ctrl-C to cancel current run, Ctrl-D to exit.
- No session persistence in v1.0 — `texra resume` and `--continue` ship in v1.1 alongside the JSONL session store (round 2 §27).

**3. Discovery + plumbing** (~150 LOC; unchanged from §33.1)

- `texra agents list`, `texra models list`, `texra version`, `texra --help`.

**Total v1.0: ~2,550–2,850 LOC** (1,000 + 1,400–1,700 + 150)**, ~5 weeks single-engineer.** Larger than round 3's ~1,650 because the Ink REPL is the largest single UI investment in the CLI; smaller than rounds 1+2's ~5,330+ because MCP, OAuth, keyring, file config, sessions, hooks, and the GitHub Action all defer.

### 34.2 What v1.0 explicitly does NOT ship (vs §33.2)

| Item                                                           | Defer to   | Why                                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `texra mcp serve` (was v1.0 in §33.1)                          | **future** | Per user direction (round 4, reinforced 2026-05-09: "Don't do MCP yet"). Not part of the v1.x roadmap; revisit when there is concrete demand to wire TeXRA into another agent host. |
| Approval policies `auto-edits` / `auto` (in-project predicate) | v1.1       | `never` / `ask` / `yolo` cover the simple cases; in-project predicate is round 2 §26.3.                                                                                             |
| OAuth loopback + device-code                                   | v1.1       | Env vars cover ~95% of users; once auth is in, sessions/keyring follow.                                                                                                             |
| Keyring + file-secrets fallback                                | v1.1       | Env vars + a `--api-key` flag cover the gap until OAuth lands.                                                                                                                      |
| `conf` + Zod layered config                                    | v1.1       | Env vars + flags are enough until users complain.                                                                                                                                   |
| `texra resume` / `--continue` / session JSONL                  | v1.1       | Each `texra chat` is a fresh session in v1.0.                                                                                                                                       |
| `texra-base-action` GitHub Action                              | v1.2       | Users `npm install -g @texra/cli` in a workflow step today.                                                                                                                         |
| Hook system, `texra doctor`, Bun binaries                      | v1.2+      | Speculative or convenience-only.                                                                                                                                                    |

### 34.3 On Ink — round 4 reverses round 3

Round 3 §33.3 said "v1.0 ships _no_ REPL → no Ink dependency." Round 4 reverses: **Ink ships in v1.0 as the lazy chunk for `texra chat`.** Pick, gating, and chunk-size budget all unchanged from round 1 (§6 #2, §11.3, §13.2). One-shot inline prompts use `@clack/prompts` per round 1 §6 #4; streaming-style approvals render through `<ApprovalCard />`.

### 34.4 Phase plan (revised v1.0)

| Phase     | Scope                                                                                                                                                              | Weeks |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| A         | Workspace package + `texra run <workflow-agent>` + headless renderer (text + NDJSON) + `agents list` + `models list` + `version` + `--help`                        | 1.5   |
| B         | Approval engine (`never` / `ask` / `yolo`) + edit / bash / plan / proposal / retry / external-inquiry handlers + `--allowed-tools` / `--disallowed-tools` plumbing | 1.5   |
| C         | `texra chat` Ink REPL: `<App />`, `<StreamPane />`, `<ApprovalCard />`, `<PromptInput />`, slash-command dispatch, Ctrl-C cancellation                             | 1.5   |
| D         | Polish: release scripting, `npm publish`, README quickstart                                                                                                        | 0.5   |
| **Total** | **~5 weeks single-engineer; ~3.5 weeks for two engineers (B + C overlap after A)**                                                                                 | **5** |

Phase B largely gates Phase C — `texra chat` cannot _ship_ without working approval handlers — but Phase C can build the REPL skeleton (`<App />`, `<StreamPane />`, `<PromptInput />`, slash-command dispatch, Ctrl-C) against a stub approval handler in parallel with B once A's plumbing lands. Final wiring of B's edit / bash / plan / proposal / retry / external-inquiry handlers into the REPL is the join point. Phase B's handlers are CLI-side glue against existing kernel seams (`setToolEditApprovalHandler`, `bashApprovalController`, etc.), not kernel work.

### 34.5 Success criteria for v1.0 (revised from §33.7)

- `npm install -g @texra/cli && texra run polish --input paper.tex --output paper.polished.tex` succeeds with only `ANTHROPIC_API_KEY` set.
- `texra chat` boots into the Ink REPL on TTY, runs an orchestrator session against `cwd`, streams tool calls + responses live, prompts inline for edit / bash approval, respects Ctrl-C cancellation.
- `texra chat --approval-policy yolo` runs an end-to-end multi-tool flow without prompts.
- `texra chat --approval-policy never` denies the gate and returns the denial to the model as feedback (exit code 4 was retired in 2026-08).
- `texra agents list -o json | jq` parses; schema matches `@shared/schemas`.
- Cold start `texra --help` < 100 ms (Ink only loads when entering chat).
- No regression in extension or desktop builds.

### 34.6 MCP — out of the v1.x roadmap

Per user direction reinforced 2026-05-09 ("Don't do MCP yet"): `texra mcp serve` is not in v1.x. The round 2 §24 design stays in the PRD as a **future** option to revisit when there is concrete demand from a calling host (Claude Code / Codex / opencode user wiring TeXRA into their flow). Until then, the CLI is sized and shipped purely as a standalone product.

The logger PRD's `McpProgressSink` (Phase 5, see [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md) §15.5) lands alongside MCP whenever that ships — not part of the v1.x logger work.

### 34.7 What round 4 does NOT change

Round 1's architecture, platform impls, repo layout, and tech-stack picks all stand. Round 2's MCP-server design (§24) is correct — it just is not part of v1.x. Round 3's logger v2 trims (§33.5, see also `2026-05-06-prd-logger-v2.md` §15) all stay in force. Round 4 is a scope reordering, not a redesign.

The intended shape stays coherent across hosts:

- **Extension** stays the richest VS Code-native shell.
- **Desktop** stays the Electron shell over the same shared kernel contracts.
- **CLI v1.0** is the standalone shell for workflow + interactive use — the canonical lens of round 4.
- **MCP** is a future interoperability surface layered on top whenever it lands; it is not what defines the CLI and is not on the v1.x roadmap.

The v1.x sequencing: **interactive + workflow** (v1.0, ~5 weeks) → **auth, config, secrets, sessions, `auto-edits`/`auto` policies** (v1.1, ~3 weeks) → polish + `texra doctor` + GitHub Action (v1.2, ~1.5 weeks) → MCP and other interop surfaces if and when there is demand (post-v1.x).

## 20. Single source of truth and abstraction budget

The CLI is a small host, but it must not become a shallow host. Its size is acceptable only when the shared kernel remains the owner of agent semantics and the CLI owns terminal-specific effects. The CLI must not copy extension or desktop logic merely to avoid importing the correct shared module.

### 20.1 Process data has one reader

`packages/cli/src/runtime/cliContext.ts` is the only CLI module that may read process input such as `process.argv`, `process.cwd()`, environment-derived defaults, package metadata, output-format defaults, approval-policy defaults, and resource-root selection. Command modules receive a resolved `CliContext`. They may interpret command intent, but they must not independently query process state.

This mirrors the design discipline used by Codex-like terminal agents: command parsing is separated from the resolved run context, and the rest of the program consumes the context rather than repeatedly consulting ambient process state.

### 20.2 Shared core versus host effects

The shared core owns agent execution semantics, run context, logger records, model selection, agent directory discovery, and approval request identities. The extension owns VS Code commands, webviews, notifications, and editor integration. The desktop app owns Electron windows, IPC, and desktop presentation. The CLI owns terminal output, exit codes, non-interactive approval policy, and future interactive terminal chat.

A new abstraction is acceptable only if it removes duplication across hosts or makes an invariant harder to violate. A module that only forwards data without owning a decision is not part of the design; it should be deleted and its callers should use the source of truth directly.

### 20.3 PR evidence

Every CLI PR must show its work. The PR description must name the single source of truth affected by the change, describe duplication removed or avoided, justify any new abstraction by the invariant it owns, and state the host impact for extension, desktop, and CLI. This requirement is part of the design: without it, the project will slowly accumulate parallel host implementations that are harder to maintain than the original VS Code-only code.

## 21. Interactive TUI renderer decision: OpenTUI preferred, guarded by distribution proof

OpenTUI is the preferred candidate for `texra chat` if its Node/npm distribution path is stable enough for TeXRA's installation model. Its terminal renderer, layout primitives, input handling, code/diff-oriented components, and production use in OpenCode fit the shape of a terminal agent interface better than a minimal prompt library.

This preference does not change the v1 boundary. `texra run`, JSON/NDJSON output, approval policy, logger records, and agent execution must remain independent of OpenTUI. The OpenTUI dependency, if adopted, must be lazy-loaded from the chat implementation only. The shared core must not import OpenTUI, React/Solid bindings, or terminal-renderer types.

Adoption is blocked until the implementation PR proves the following:

- Node 20+ execution works from the published npm package without requiring Bun at runtime.
- Installation works on Linux, macOS, Windows, and GitHub Actions without requiring users to install Zig manually.
- The package can be isolated to interactive chat so headless `texra run` and `texra-action` do not pay its install or startup cost.
- The CLI keeps one small terminal boundary, for example `runInteractiveChat(context)`, rather than introducing a broad TUI abstraction.

If those conditions are not met, keep OpenTUI as the target renderer and ship the first interactive loop with a smaller Node-stable terminal stack. The renderer is a host presentation choice, not an agent-runtime decision.

## 22. Chat mode must be a follow-up conversation surface

`texra chat` is not a read-only progress viewer. It must provide a terminal input surface that lets the user continue the same agent session with follow-up messages. The TUI owns input editing, submission, interruption, and local rendering; the shared tool-use runtime owns session state, model routing, tool-call state, approvals, and persistence.

Minimum interactive requirements:

- A persistent input box or prompt for user messages.
- Submission of follow-up turns into the active tool-use session without creating a parallel session model in the CLI package.
- Visible assistant output, tool calls, tool results, plans, todos, and pending approvals in the same terminal surface.
- Clear interruption behavior: `Ctrl-C` interrupts the active run; a second `Ctrl-C` or explicit `/exit` exits the chat.
- Slash commands are local terminal commands only when they affect presentation or host policy, for example `/exit`, `/clear`, `/yolo`, `/model`, or `/agent`. They must not fork core session semantics.
- Headless mode must reject chat rather than hanging for input.

OpenTUI remains the preferred renderer if distribution proof succeeds because this requirement needs a real terminal UI, not just a sequence of one-shot prompts.

## 23. Agent TUI outer-shell requirements

The OpenRouter `create-agent-tui` reference is useful for the terminal shell requirements. TeXRA should not copy its generated harness, because TeXRA already owns the agent loop, tools, approvals, logger, and session lifecycle. The lesson is the boundary: the TUI is the outer shell around an existing agent runtime.

`texra chat` should therefore include, in priority order:

- A real input component for follow-up turns.
- Streaming assistant text and tool-call display in the same surface.
- Grouped, minimal, and hidden tool-display modes.
- A plain readline-compatible fallback input mode for terminals where rich rendering is unsafe.
- Session metadata display: active agent, active model, working directory, usage/cost when available, and resume identity.
- Permission prompts integrated with the CLI approval adapter.
- Future `@file` and `!command` shortcuts only if they feed the existing tool-use runtime and do not create parallel file or shell subsystems.

This strengthens the OpenTUI decision: a full TUI is justified because chat must support follow-up input, streaming output, approvals, and session state in one terminal surface. Renderer choice remains host-local and lazy-loaded.

## 24. Local TUI styling reference

A local reference clone of the OpenRouter skills repository is available at `references/openrouter-skills`. The relevant material is `references/openrouter-skills/skills/create-agent-tui/`.

Use it as a visual and interaction reference for `texra chat`, especially input styles, tool-call display styles, loader behavior, and session metadata. Do not vendor or copy its generated harness into TeXRA. TeXRA's runtime, tool registry, approval lifecycle, logger, and session state already have owners in this repository.
