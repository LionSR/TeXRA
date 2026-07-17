# CLAUDE.md

Guidance for Claude Code when working with this repository. For detailed coding conventions and patterns, see [AGENTS.md](./AGENTS.md).

## Code review

For `/review` or any code review on this repo, load [.claude/skills/code-review/SKILL.md](./.claude/skills/code-review/SKILL.md) first — generic passes miss the repo-specific rules below. Always include a `Verified` section listing what you opened.

## Project Overview

TeXRA is an AI theorist that helps academics with writing, research, and document processing using Large Language Models. It ships as a VS Code extension, a standalone Electron desktop app, and a terminal CLI (`texra`) — three hosts sharing one host-agnostic core (see Workspace Layout below).

## Development Commands

```bash
# Install dependencies
corepack pnpm install

# Development build (esbuild + Vite)
npm run compile:fast

# Development build with watch mode
npm run watch:fast

# Production build
npm run package:fast

# Build VSIX extension file
npm run build:fast
# Creates: releases/texra-{version}.vsix

# Build both the desktop app and VSIX, then verify release artifacts
npm run build:initial

# Run linting only
npm run lint

# Format code with Prettier
npm run format

# Run the test suite (Vitest)
npm test

# Type check (builds don't; esbuild only strips types)
npm run typecheck

# Dead-export gate (fails on any unused export not in config/ratchets/knip-baseline.json)
npm run check:dead-code-ratchet
```

### Builds and Type Checking

All builds use esbuild (for the extension host) and Vite (for webviews); the legacy webpack pipeline has been removed, and `npm run compile` / `watch` / `package` are aliases for the `:fast` variants listed above.

**Important:** These builds do NOT perform TypeScript type checking (esbuild only strips types). Run `npm run typecheck`, or use the `:safe` variants (`compile:safe`, `package:safe`, `build:safe`) that type check before building. Build-system rationale and the full safe-script table: AGENTS.md "Build system: esbuild + Vite".

### Local CLI (`texra-local`)

To run your locally-built CLI alongside a globally-installed published `texra`:

```bash
npm run texra-local:build   # bundle the CLI + copy resources/docs into packages/cli/dist
npm run texra-local:link    # symlink `texra-local` into ~/.local/bin (one-time)
```

`texra-local` is a symlink to `packages/cli/dist/bin/texra.js`, which each build
overwrites in place — so it always runs your latest local build, no relinking
needed. Re-run `texra-local:build` to refresh. Override the install dir with
`TEXRA_LOCAL_BIN_DIR=/some/dir npm run texra-local:link`.

## Architecture Overview

### Agent System

The core of TeXRA is its agent architecture in repo-root `src/agent/`:

- **`core/`** holds the host-agnostic domain model, organized by bounded concern: `definition/` (what an agent is), `state/` (run-state snapshots), `usage/` (usage value objects), `tools/` (tool contracts), and `flows/` (reusable cycle primitives). See `src/agent/core/README.md` for the module map and dependency rules.
- **`implementations/flows/`** provides the PocketFlow-based flow implementations (`reflection`, `tooluse`, `agentCreator`)
- **`modelHandlers/`** abstracts AI provider APIs (Anthropic, OpenAI and OpenAI-compatible families, Google, OpenRouter, VS Code LM). No barrel: import via the `@agent/modelHandlers/<provider>/<File>` alias, per that directory's `README.md`
- Agents are configured via YAML files in `packages/extension/resources/agents/`

Agent prompts handle single and multi-document output through one unified YAML per agent. Workflow edit prompts use the input filenames as the output filenames, and agents that generate new artifacts may declare `defaultOutputFiles` and refer to `OUTPUT_FILES`.

### Workspace Layout

This repository is a pnpm workspace:

- Repo-root `src/` holds host-agnostic core logic, platform interfaces, shared schemas, and test harness code.
- `packages/extension/` holds the VS Code extension entrypoint, commands, webviews, and packaged resources.
- `packages/desktop/` holds the Electron desktop shell and adapters around the shared core.
- `packages/cli/` holds the `texra` terminal client (Ink TUI plus headless `texra run` / `--print` modes).
- `packages/trace-viewer/` holds the standalone trace-viewer web app (`@texra/trace-viewer`), built with Vite and bundled into host resources.
- `src/hosts/` defines host capability ports used by both VS Code and Electron integrations.
- `src/test-kernel/` contains Vitest suites for host-neutral and Electron-facing behavior.

There is currently no `@texra/core` workspace package. Hosts import shared core through the repo-root path aliases until a future SDK surface is enforced with a build and import-boundary lint gate.

### Source Organization

Key directories in `src/`:

- `agent/` - Agent core, implementations, model handlers, runtime, output, storage, remote, node, trace, goal, review, export, followUp, templates, features
  - `implementations/flows/` - PocketFlow-based flow implementations (`reflection`, `tooluse`, `agentCreator`)
- `platform/` - Platform abstraction layer (composition root). Hosts (VS Code, CLI, Electron) call `initPlatform()` once at startup; core code accesses host services via `platform()` from `@platform/platform`. See `src/platform/platform.ts`.
- `controllers/` - Host-neutral orchestration for the main, progress, and settings views behind injected ports, including the progress-view backend
- `common/` - Backend-only helpers (errors, state, files, webview base classes)
- `utils/` - Utilities shared between extension host and webviews
- `tools/` - Tool implementations for tool-use agents
- `model/` - Model configuration, registry, and providers
- `latex/` - LaTeX processing (formatting, diff, TikZ, PDF)
- `shared/` - Wire contracts, shared schemas, and UI-shared message types; do not put host orchestration or new `@agent/*` dependencies here
- `auth/` - Authentication logic
- `housekeeping/` - Cleanup and packing operations
- `hosts/` - Host capability interfaces for clipboard, prompts, terminals, diff views, and openers
- `logger/` - Logging infrastructure
- `eventBus/` - Cross-cutting app-lifecycle signals (`AppSignals`: auth, subscriptions, tool availability, workspace-file writes) — not run/session progress events; see `agent/trace` and `SessionEventHub` (`agent/runtime/`) for those
- `replacement/` - Text cleanup rules
- `skills/` - Skill schemas, loading, and runtime skill sources
- `telemetry/` - Usage logging
- `transcript/` - Stream logs, snapshots, and run transcript recording
- `types/` - Ambient type declarations (`ambient.d.ts`)
- `test-kernel/` - Vitest suites (run via `npm test`); shared fakes live in `test-kernel/support/`

Key directories in `packages/extension/`:

- `packages/extension/src/extension.ts` - VS Code extension entry point
- `packages/extension/src/MainViewProvider.ts` - Webview provider wiring for the main view
- `packages/extension/src/commands/` - VS Code commands organized by domain (see below)
- `packages/extension/src/common/` - Webview/state base classes shared across extension views
- `packages/extension/src/frontend/` - Extension-host utilities for shared UI flows
- `packages/extension/src/schemas/` - Extension-specific settings schemas
- `packages/extension/src/webview/` - Main agent interaction interface
- `packages/extension/src/progressView/` - Task tracking board
- `packages/extension/src/settingsView/` - Unified settings webview (Memory, History, Models, Agents, Multi-Agent, Tools, AI Agents, Git, LaTeX, Goal tabs)
- `packages/extension/resources/` - Packaged agents, tool-use agents, docs, templates, examples, and extension assets

Key documentation in `docs/`:

- `pocketflow/` - PocketFlow framework documentation (core abstractions, design patterns, utility functions)
- `guide/` and selected root docs (`index.md`, `launch.md`, `providers.md`, `changelog.md`, `terms.md`) are published on the texra.ai VitePress site. Internal directories such as `architecture/`, `blog/`, `design/`, `dev/`, `prds/`, `proposals/`, `reference/`, `skills/`, and `supabase/` are excluded by `docs/.vitepress/publicDocs.js`. A doc landing at the `docs/` root can silently freeze the texra.ai deploy if it trips the publish allowlist — check `docs/.vitepress/publicDocs.js` and the commit-time `docs-root-boundary` pre-commit gate (`docs/scripts/check-root-docs.mjs`) before adding root-level docs.

### Commands (`packages/extension/src/commands/`)

- `_shared/` - Helpers shared across command domains
- `agent/` - Running and managing agents, merge operations
- `api/` - API key management
- `auth/` - Authentication commands
- `files/` - File selection and management
- `git/` - Git integration
- `housekeeping/` - Cleanup, packing, and utilities
- `latex/` - LaTeX operations (diff, figures, etc.)
- `progress/` - Progress board management
- `review/` - Agent review commands
- `settings/` - Settings view commands
- `setup/` - Setup assistant
- `system/` - Help, tests, XML/YAML utilities, editor commands
- `taskFormState/` - Main-view task form state restoration (`texra.restoreState`); the execution-history list (rerun/delete/export) lives in `settingsView/handlers/historyHandlers.ts`, not here
- `tests/` - Test commands

### Schemas (Zod v4)

Zod schemas are the single source of truth for data structures: define the schema first, derive types with `z.infer`, compose with `.extend()`/`.pick()`, and prefer `z.discriminatedUnion()` over `z.custom<T>()`. Legacy data formats are normalized once at the entry point with a `z.union()` whose legacy member `.transform()`s into the one canonical format; downstream code never branches on format version. Full patterns (SSOT rules, the backward-compatibility union, `.prefault()`/`.catch()`/`.nullish()`, and tool-schema design): AGENTS.md "Zod v4 Schema Patterns".

### Abstraction discipline

Collapse pass-through layers: nodes create and run flows directly in `exec()`; a wrapper that only creates state, runs a flow, and interprets results gets inlined; deleted wrappers leave no re-export shims behind. Factories are justified only by multiple callers, meaningful logic (validation, defaults, transforms), class construction, or captured initialization context; two-layer factories called once and identity factories that just spread into a new object are banned. At review time this extends into the **Abstraction-cost guardrails** (code-review checklist § 13): grep the caller count before approving any new shared helper (single-caller extractions are banned), and hold new ports/facades/template-methods to build-implies-delete-in-the-same-PR with net-LOC accounting. Full patterns with examples: AGENTS.md "Design and refactoring".

### UI anti-patterns

Two standing bans, detailed in AGENTS.md "UI anti-patterns": never compensate for data-model problems at render time (no `Date.now()`, synthetic IDs, or dedup logic in renderers; fix the upstream data), and one home per user action (never surface the same action from two controls; secondary surfaces show read-only status). Duplicate-control grep procedure: code-review checklist § 5.

### Terminal UI (CLI / Ink) discipline

The `texra` CLI ships an Ink (React) TUI under `packages/cli/src/chat/tui/`.
It deliberately does **not** take over the viewport (no alternate screen); the
root transcript appends finalized content to native scrollback and only repaints
a small live region at the bottom. Focused child streams use the same ownership
model: the active viewport selects exactly one stream to feed native scrollback,
and the live region only paints that stream's in-flight tail. Keep those
viewports distinct — the terminal already implements scrolling, search, and
mouse-scroll for finalized history, so don't reinvent them.

- **Root scrollback owns finalized root history.** In the root viewport, every
  finalized root transcript entry prints exactly once through Ink `<Static>`
  (`panes/StaticConversationTranscript.tsx`) so native scrollback / search /
  mouse-scroll keep working. Never render a finalized root turn in the root live
  region, and never reprint root `<Static>` items unless the repaint starts from
  a known origin — dedupe by the entry's own stable id, not a stream-scoped key
  (see `appendStaticTranscriptItems`). Focused child streams are separate
  viewports that temporarily select the child as the `<Static>` scrollback
  owner; root and child histories must not share append-only Static state.
- **Keep the live region minimal for the active viewport.** In root mode, only
  in-flight content belongs in the redrawn `<Box>` below `<Static>`: the
  streaming tail, spinners, side panels, input bar, and the active approval
  modal. In child focus, the same live region renders only the focused child's
  pending entries through the bounded row-budgeted path; full child history
  belongs to that child's Static scrollback owner. Ctrl-T appends a full-output
  snapshot through that same owner rather than opening a second viewport.
  Cap root panels (`BOTTOM_PANEL_MAX_ROWS`) so chrome never pushes the input
  off-screen. Don't park finalized content in the live region "for now."
- **Stateless renderers.** Tool / diff / markdown components are props-in → JSX-out (the render-time workarounds ban from "UI anti-patterns", applied to the TUI). No `Date.now()`, synthetic ids, or dedup at render time. Any view-level toggle (collapse/expand, focus) belongs in shared signal state (`state/cliState.ts`), not per-component local state.
- **Defer non-terminal content to the host.** The TUI does not render PDFs, LaTeX figures, or inline images (iTerm2 / Kitty / Sixel). Hand previews to the webview/desktop or the OS opener. The terminal is for chat, text, and diffs; rebuilding a document viewer in cells is out of scope.
- **Capability-gate terminal features.** Negotiate support via the DA1-sentinel discovery (`state/terminalCapabilities.ts`) before emitting Kitty-keyboard, OSC color, bracketed-paste, or notification sequences. No "assume a modern terminal" feature use.
- **Headless parity is sacred.** The TUI runs only on an interactive TTY. `texra run`, `--print/-p`, and `--output-format json|ndjson` must stay byte-identical — never let Ink rendering, ANSI chrome, or spinners leak into the piped / non-TTY path.
- **Width changes and scoped returns invalidate wrapped lines.** Soft-wrap is
  width-dependent: recompute live-region layout from `useWindowSize()` columns
  on every render; never cache wrapped output across a width change. On a width
  change the vendored `ink` patch (`patches/ink@7.1.0.patch`) deliberately does
  a **full repaint** — `ansiEscapes.clearTerminal` then reprint live chrome
  (including the session header) plus `fullStaticOutput` (finalized history,
  reflowed), with the live region drawn below — debounced so a drag-storm
  collapses into one redraw.
  Any transcript viewport switch (`root` ↔ scoped child, or child ↔ child) uses
  the same known-origin pattern: clear scrollback, drop cached static output,
  then repaint the new viewport. Root viewports reprint root `<Static>` history;
  child viewports reprint only the focused child's `<Static>` history.
  Line-count erasing of the live region can't survive reflow, because the
  emulator owns the reflow/scroll geometry and a write-only stdout can't observe
  it, so any fixed erase count either strands residue or walks up and eats the
  live session header. Don't "fix" this back to line-count erasing; the
  no-repaint rule applies to steady-state rendering, not resize or transcript
  viewport switches.
- **Sync-teardown terminal restoration on every exit path.** `exitNow()`/every
  signal handler does synchronous `writeSync` mode-disable (mouse, kitty,
  bracketed paste, cursor) before any async drain, wired to SIGINT/SIGTERM/SIGHUP.
  Implemented in `runChatTui.tsx`; route new mode toggles through that same
  synchronous path.
- **Per-transcript-entry render-null error boundaries.** Every transcript entry
  is wrapped in `EntryErrorBoundary` (`panes/ConversationPane.tsx`,
  `panes/StaticConversationTranscript.tsx`), so one malformed entry degrades to
  blank instead of blanking the session. New transcript renderers must live
  inside it.
- **Not yet built — adopt when touched:** animations should share one Clock
  (single timer, idle when unsubscribed, offscreen rows unsubscribe via a
  ref-only check) instead of per-component intervals; raw mode should be
  reference-counted (enable on 0→1, disable on 0, snapshot/restore across
  Ctrl-Z) instead of toggled directly; the resize clear+reprint should wrap in
  DEC 2026 sync-output (BSU/ESU, gated on the existing DECRQM 2027 probe) if a
  blank flash is ever observed; prefer a `/dev/tty` fallback over refusing the
  TUI when stdin is piped but a real terminal is present, and handle EPIPE
  globally. Full rationale and citations:
  `docs/proposals/ink-practices-from-claude-code.md`.

### CLI design (clig.dev)

The `texra` CLI (`packages/cli/`) follows the [Command Line Interface
Guidelines](https://clig.dev). When working on it, design to the guide's
philosophy and guidelines rather than ad-hoc choices.

**Philosophy.** Human-first design; simple parts that work together (composable
via stdin/stdout, exit codes, and signals); consistency across programs; saying
(just) enough; ease of discovery; conversation as the norm; robustness; empathy.

**Guidelines.** Apply the relevant section of the guide:

- **The basics.** Use the arg-parsing library; zero exit on success, non-zero
  on failure; primary/machine-readable output to stdout, logs and errors to
  stderr.
- **Help & documentation.** `-h`/`--help` everywhere, concise by default and
  full on request; lead with examples; link to web docs; suggest a command when
  the user mistypes.
- **Output & errors.** Human-readable by default, machine-readable (JSON) where
  it doesn't hurt usability; rewrite errors for humans; make bug reports easy;
  use color with intention and disable it off-TTY / `NO_COLOR` / `TERM=dumb`.
- **Arguments & flags.** Prefer flags to args; full-length plus short forms;
  standard names; `-` for stdin/stdout; confirm destructive actions.
- **Interactivity.** Only prompt on a TTY; honor `--no-input`; never require a
  prompt.
- **Subcommands, robustness, future-proofing, signals.** Consistent naming;
  validate input and stay responsive; keep changes additive; handle Ctrl-C.
- **Configuration & environment.** Precedence flags > env > project > user >
  system; honor general-purpose vars (`NO_COLOR`/`FORCE_COLOR`, `PAGER`, …).

Don't reinvent the wheel: lean on `citty` (parsing/help) and `picocolors`
(color), and reach for existing libraries over bespoke implementations.

### Separation of Concerns: VS Code Coupling

For good separation of concerns, testability, and platform independence, core business logic should not depend on the `vscode` module. Keeping domain logic free of host-specific imports makes the code easier to test, reason about, and reuse.

**VS Code-free zones** — these directories must NOT import `vscode`:

- `src/agent/` (core logic, model handlers, PocketFlow flows)
- `src/model/` (model registry, capabilities, pricing)
- `src/latex/` (LaTeX processing, formatting, diff)
- `src/tools/` (tool implementations — use `@utils/files/fsEntryType` instead of `vscode.FileType`)
- `src/controllers/` (host-neutral orchestration behind injected ports)
- `src/shared/` (wire contracts, IPC schemas, message types; no new `@agent/*` imports)
- `src/replacement/` (text cleanup rules)
- `src/eventBus/` (cross-cutting app-lifecycle signals — `AppSignals`, not progress events; see the run/session-fact rule below)
- `src/hosts/` (host capability ports)
- Webview frontends (`packages/extension/src/webview/frontend/`, `packages/extension/src/progressView/frontend/`, `packages/extension/src/settingsView/frontend/`)

**VS Code-allowed zones** — platform-specific wiring belongs here:

- `packages/extension/src/extension.ts` (entry point — calls `initPlatform()` exactly once with the VS Code-backed services)
- `src/platform/` interfaces themselves (interface definitions; concrete VS Code implementations are wired from `extension.ts`)
- `packages/extension/src/commands/` (VS Code command handlers)
- `packages/extension/src/frontend/` (VS Code UI utilities)
- `src/common/webview/` (webview base classes)
- `packages/extension/src/common/state/` (state managers backed by VS Code Memento)
- `src/utils/config/` (wraps `vscode.workspace.getConfiguration`)
- `src/utils/files/workspaceFS.ts`, `storageFS.ts` (wraps `vscode.workspace.fs`)
- `src/auth/` (authentication providers)
- VS Code logging output-channel creation belongs in the extension-host wiring, not in repo-root logger modules.

**Patterns for keeping code platform-agnostic:**

- Reach host services through `platform()` from `@platform/platform` (config, state, log, fs, workspace, storage, secrets) — never import `vscode` in agnostic zones.
- Add typed `Platform` ports (like `toolAvailability.isVscodeExtensionInstalled`) for platform-specific capabilities needed in agnostic code
- Helper substitutions for `vscode` types (`isFile`/`isDirectory`, `isFileNotFoundError`, numeric file types) and the push-UI-to-the-caller rule: AGENTS.md "Platform decoupling rules"
- New run-scoped facts extend `AgentEvent` (trace), and session-scoped facts extend `SessionFact` — never a new `bus.emit` from a VS Code-free zone, and never a new subscribe surface. (Ruled in `docs/proposals/error-pipeline-and-ownership.md`. The direct `bus.emit` sites in `src/tools` that this rule once grandfathered have since been migrated to session-owned event-hub emission — see `SessionHandle.events` / `SessionEventHub` in `src/agent/runtime/` — so the exception no longer applies; a new direct `bus.emit` from a VS Code-free zone is a rule violation, not a grandfathered pattern.) This rule targets run/session-scoped facts specifically — it does not apply to `appSignals.emit(...)` calls against the separate, documented `AppSignals` cross-cutting bus (`src/eventBus/AppSignals.ts`: auth, subscriptions, tool availability, workspace-file writes), which remain legitimate from VS Code-free zones within their documented scope.

### Path Aliases

Common aliases (full list in `tsconfig.json`):

- `@agent/*`, `@commands/*`, `@common/*`, `@frontend/*`, `@utils/*`
- `@model/*`, `@latex/*`, `@logger/*`, `@tools/*`, `@webview/*`
- `@progressView/*`, `@settingsView/*`, `@shared/*`, `@eventBus/*`
- `@replacement/*`, `@housekeeping/*`, `@auth/*`, `@types/*`
- `@controllers/*`, `@hosts/*`, `@skills/*`, `@telemetry/*`, `@transcript/*`
- `@cli/*`, `@desktop/*`, `@test/*`, `@resources/*`, `@extensionSchemas/*`
- `@platform/*` (platform abstraction layer; import `platform()`/`initPlatform()` from `@platform/platform`)

## Adding New Components

### New Command

1. Create file in appropriate `packages/extension/src/commands/` subdirectory
2. Export command function following existing patterns
3. Register in `packages/extension/src/commands.ts`

### New Agent

1. Create YAML definition in `packages/extension/resources/agents/`
2. If needed, implement new agent type in `src/agent/implementations/`

### New Model Provider

1. Create handler under `src/agent/modelHandlers/<provider>/` (no barrel; consumers import via the `@agent/modelHandlers/<provider>/<File>` alias)
2. Register capabilities and pricing in `src/model/computeModelOptions.ts`

## Release Process

TeXRA ships three release tracks off the same commit, with identical user-facing notes. Publishing itself is CI-driven (`.github/workflows/release.yml`, fired by `release: published`) — the manual steps are only: update the changelog, cut two tags, and create two GitHub Releases (one per tag). No local `vsce`/`ovsx`/`npm publish` invocation and no OTP are needed.

1. Update `CHANGELOG.md`: move `[Unreleased]` content into a new dated `## [X.Y.Z] - YYYY-MM-DD` section (folding in anything that accumulated since a prior draft that never shipped), commit, and push to `main`.
2. Cut both tags off that commit and push them: `git tag vX.Y.Z <sha> && git tag cli-vX.Y.Z <sha> && git push origin vX.Y.Z cli-vX.Y.Z`.
3. Create two GitHub Releases from those tags, body = the changelog section for that version (extract with something like `awk '/^## \[X.Y.Z\]/{f=1} /^## \[PREV\]/{f=0} f' CHANGELOG.md`):
   - `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>` — triggers `publish-extension`: builds the VSIX (`pnpm --filter texra build:fast`) and publishes to the VS Code Marketplace and Open VSX via stored PATs (`VSCE_PAT`/`OVSX_PAT`, `skipDuplicate: true`). Also triggers `version-bump.yml` (gated to the plain `vX.Y.Z` tag only, so it doesn't double-fire off the `cli-` tag), which opens a PR bumping every package manifest to the next dev version — that PR does **not** touch `CHANGELOG.md`.
   - `gh release create cli-vX.Y.Z --title cli-vX.Y.Z --notes-file <notes>` — triggers `publish-cli`: `npm publish` from `packages/cli` over npm Trusted Publishing (OIDC `id-token: write`), so it runs unattended in CI — no OTP.
   - Both jobs assert the release tag matches the corresponding `package.json` version and fail closed if it doesn't — cut the tags only after that manifest version is actually on `main`.
   - If a tag/release for a version was created previously but the workflow never ran (e.g. abandoned mid-release), re-running `gh release create` reuses the existing tag — pass no `--target` (an explicit `--target` on a tag that already has a commit 422s).
4. **Desktop**: `.github/workflows/desktop-package.yml` is `workflow_dispatch`-only (not release-triggered) — build signed macOS/Linux/Windows installers and publish them to the public `texra-ai/texra-desktop-releases` repo by dispatching it with `run_desktop_installers`, `run_windows_desktop`, `require_desktop_signing`, and `publish_desktop_release_artifacts` all `true`.
5. If this release changes `llm-zoo`, also update the exact pin in `supabase/functions/relay/deno.json` and refresh `supabase/functions/relay/deno.lock` (called out in the `version-bump.yml` PR body, but easy to miss since it isn't part of the automated bump).

**Changelog guidelines**: Focus on user-visible changes. Never document intermediate bugs fixed within the same PR. Full rules: AGENTS.md "Changelog Guidelines".
