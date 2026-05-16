# CLAUDE.md

Guidance for Claude Code when working with this repository. For detailed coding conventions and patterns, see [AGENTS.md](./AGENTS.md).

## Code review

For `/review` or any code review on this repo, load [.claude/skills/code-review/SKILL.md](./.claude/skills/code-review/SKILL.md) first — generic passes miss the repo-specific rules below. Always include a `Verified` section listing what you opened.

## Project Overview

TeXRA is a VS Code extension that serves as an AI-powered LaTeX research assistant. It uses Large Language Models to help academics with writing, research, and document processing.

## Development Commands

```bash
# Install dependencies
corepack pnpm install

# Development build (recommended - uses esbuild + Vite, much faster)
npm run compile:fast

# Development build with watch mode (recommended)
npm run watch:fast

# Production build (recommended - uses esbuild + Vite)
npm run package:fast

# Build VSIX extension file (recommended)
npm run build:fast
# Creates: releases/texra-{version}.vsix

# Build both the desktop app and VSIX, then verify release artifacts
npm run build:initial

# Run linting only
npm run lint

# Format code with Prettier
npm run format

# NOTE: Do NOT run `npm test` - it attempts to download VS Code test environment which will fail and waste time.
```

### Fast Builds (Recommended)

The project supports fast builds using esbuild (for the extension host) and Vite (for webviews):

- `npm run compile:fast` - Development build
- `npm run watch:fast` - Watch mode for development
- `npm run package:fast` - Production build
- `npm run build:fast` - Build VSIX extension file
- `npm run build:initial` - Build desktop plus VSIX artifacts and verify both

These commands are significantly faster and do not require increased memory allocation.

**Important:** Fast builds do NOT perform TypeScript type checking (esbuild only strips types). To verify there are no type errors, run:

```bash
npm run typecheck
```

Alternatively, use `npm run compile:safe` which runs type checking before building.

### Legacy Webpack Builds

The original webpack-based commands are still available:

```bash
npm run compile
npm run package
```

## Architecture Overview

### Agent System

The core of TeXRA is its agent architecture in repo-root `src/agent/`:

- **Core interfaces** define agent behavior and state management
- **Implementations** provide reasoning strategies (Direct, Chain-of-Thought, Merge, Workflow)
- **Model handlers** abstract AI provider APIs (Anthropic, OpenAI, Google, etc.)
- Agents are configured via YAML files in `packages/extension/resources/agents/`

Agent prompts handle single and multi-document output through one unified YAML per agent. Workflow edit prompts use the input filenames as the output filenames, and agents that generate new artifacts may declare `defaultOutputFiles` and refer to `OUTPUT_FILES`. The previous `foo_multiple.yaml` twin-file pattern was retired in May 2026.

### Workspace Layout

This repository is a pnpm workspace:

- Repo-root `src/` holds host-agnostic core logic, platform interfaces, shared schemas, and test harness code.
- `packages/extension/` holds the VS Code extension entrypoint, commands, webviews, and packaged resources.
- `packages/desktop/` holds the Electron desktop shell and adapters around the shared core.
- `packages/core/` exposes the shared core package surface for workspace consumers.
- `src/hosts/` defines host capability ports used by both VS Code and Electron integrations.
- `src/test-kernel/` contains Vitest suites for host-neutral and Electron-facing behavior.

### Source Organization

Key directories in `src/`:

- `agent/` - Agent core, implementations, model handlers, runtime, toolUse, output, storage, remote, node
  - `implementations/flows/` - PocketFlow-based flow implementations (reflection, tooluse)
- `platform/` - Platform abstraction layer (composition root). Hosts (VS Code, future CLI/Electron) call `initPlatform()` once at startup; core code accesses host services via `platform()` from `@platform`. See `src/platform/platform.ts`.
- `common/` - Backend-only helpers (errors, state, files, webview base classes)
- `utils/` - Utilities shared between extension host and webviews
- `tools/` - Tool implementations for tool-use agents
- `model/` - Model configuration, registry, and providers
- `latex/` - LaTeX processing (formatting, diff, TikZ, PDF)
- `shared/` - Shared schemas and message handlers across webviews
- `auth/` - Authentication logic
- `housekeeping/` - Cleanup and packing operations
- `hosts/` - Host capability interfaces for clipboard, prompts, terminals, diff views, and openers
- `logger/` - Logging infrastructure
- `eventBus/` - Progress event system
- `replacement/` - Text cleanup rules
- `test/` - Mocha test suites (do NOT run via `npm test`; see Development Commands)
- `test-kernel/` - Vitest suites for host-neutral and Electron-facing logic

Key directories in `packages/extension/`:

- `packages/extension/src/extension.ts` - VS Code extension entry point
- `packages/extension/src/commands/` - VS Code commands organized by domain (see below)
- `packages/extension/src/frontend/` - Extension-host utilities for shared UI flows
- `packages/extension/src/webview/` - Main agent interaction interface
- `packages/extension/src/progressView/` - Task tracking board
- `packages/extension/src/settingsView/` - Unified settings webview (History, Memory, Models, Agents, Multi-Agent, LaTeX, Tools tabs)
- `packages/extension/resources/` - Packaged agents, tool-use agents, docs, templates, examples, and extension assets

Key documentation in `docs/`:

- `pocketflow/` - PocketFlow framework documentation (core abstractions, design patterns, utility functions)

### Commands (`packages/extension/src/commands/`)

- `agent/` - Running and managing agents, merge operations
- `api/` - API key management
- `auth/` - Authentication commands
- `files/` - File selection and management
- `git/` - Git integration
- `history/` - State restoration and history browser
- `housekeeping/` - Cleanup, packing, and utilities
- `latex/` - LaTeX operations (diff, figures, etc.)
- `progress/` - Progress board management
- `settings/` - Settings view commands
- `system/` - Help, tests, XML/YAML utilities, editor commands
- `tests/` - Test commands

### Schema and Type Guidelines

Use Zod schemas as the single source of truth for data structures:

- **Define schemas first**, then derive TypeScript types using `z.infer<typeof Schema>`
- **Use schema composition** (`.extend()`, `.pick()`) instead of duplicating field definitions
- **Avoid `z.custom<T>()`** when a proper schema exists—prefer `z.discriminatedUnion()` for union types
- **Co-locate types with schemas** in the same file for maintainability
- **Add compile-time assertions** (using `satisfies`) when schemas must stay synchronized with external types

This project uses **Zod v4**. See AGENTS.md for idiomatic Zod v4 patterns including `.prefault()`, `.catch()`, and `.nullish()` for tool schemas.

### Backward Compatibility with Zod

When evolving data formats while maintaining backward compatibility:

- **Use `z.union()` with `.transform()`** to handle multiple formats in one schema
- **New format first** in the union (Zod tries in order)
- **Legacy format transforms** into the canonical structure
- **Handle legacy at entry point** using `safeParse`, not scattered fallbacks in consumers
- **One canonical format** for all downstream code—no conditional handling based on format version

Example pattern:

```typescript
// Canonical format (new)
const NewFormatSchema = z.object({ revised: OutputFileInfoSchema, ... });

// Legacy format transforms to canonical
const LegacyFormatSchema = z.object({ baseLabel: z.string(), ... })
  .transform((e): NewFormat => ({ /* map to canonical */ }));

// Single entry point handles both
const EntrySchema = z.union([NewFormatSchema, LegacyFormatSchema]);

// Usage: always returns canonical format
const result = EntrySchema.safeParse(raw);
```

### Flattening Abstraction Layers

When refactoring, eliminate unnecessary wrapper functions and indirection layers:

**Anti-pattern (too many layers):**

```
Node.exec()
  → wrapperFunction()
    → coreFunction()
      → createFlow()
      → flow.run()
```

**Preferred (direct execution):**

```
Node.exec()
  → createFlow()
  → flow.run()
```

**Guidelines:**

- Nodes should create and run flows directly in `exec()`, not delegate to wrapper functions
- If a wrapper only creates state + runs flow + interprets results, inline it
- Delete wrapper files entirely when they become unused (don't leave empty re-exports)
- Update tests to use the underlying flow directly rather than through wrappers
- Update imports to point to the source of truth (e.g., `CycleServices` not re-exporting files)

**Example refactoring impact:**

- `ResponseCycle.ts` deleted → `ResponseCycleNode` creates flow directly
- `ToolUseCycle.ts` deleted → `ToolUseCycleNode` creates flow directly
- Tests updated to use `createResponseCycleFlow()` / `createToolUseCycleFlow()` directly

### Discouraged Factory Patterns

Avoid these patterns that add indirection without value:

**Two-layer factories (called once):**

```typescript
// ❌ Anti-pattern: buildX only called from createX
export function createContext(init) {
  const services = buildServices(init);  // ← Extra layer
  return { services, ... };
}
function buildServices(init) { ... }

// ✅ Preferred: Inline if only called once
export function createContext(init) {
  const services = { ... };  // ← Direct
  return { services, ... };
}
```

**Trivial identity factories:**

```typescript
// ❌ Anti-pattern: Just spreads into new object
function createOptions(options: Options): Options {
  return { ...options };
}

// ✅ Preferred: Use object literal directly
const options: Options = { ... };
```

**When factories ARE justified:**

- Called from multiple locations (DRY)
- Contain meaningful logic (validation, defaults, transforms)
- Create class instances or complex objects
- Need to capture closures with initialization context

### Render-Time Workarounds (Anti-pattern)

Never compensate for data model problems at render time. Renderers should only transform and display.

**Signs of broken data model:**

- `Date.now()` or synthetic IDs generated during rendering
- DOM queries to check if data exists before rendering
- Deduplication logic comparing rendered content

**Fix:** Store data once at the source with all metadata (timestamps, IDs). If renderers need to generate or deduplicate, the upstream code path is missing data.

### Separation of Concerns: VS Code Coupling

For good separation of concerns, testability, and platform independence, core business logic should not depend on the `vscode` module. Keeping domain logic free of host-specific imports makes the code easier to test, reason about, and reuse.

**VS Code-free zones** — these directories must NOT import `vscode`:

- `src/agent/` (core logic, model handlers, PocketFlow flows)
- `src/model/` (model registry, capabilities, pricing)
- `src/latex/` (LaTeX processing, formatting, diff)
- `src/tools/` (tool implementations — use `@common/files/fsEntryType` instead of `vscode.FileType`)
- `src/controllers/` (host-neutral orchestration behind injected ports)
- `src/shared/` (IPC schemas, message types)
- `src/replacement/` (text cleanup rules)
- `src/eventBus/` (progress event system)
- Webview frontends (`packages/extension/src/webview/frontend/`, `packages/extension/src/progressView/frontend/`, `packages/extension/src/settingsView/frontend/`)

**VS Code-allowed zones** — platform-specific wiring belongs here:

- `packages/extension/src/extension.ts` (entry point — calls `initPlatform()` exactly once with the VS Code-backed services)
- `src/platform/` interfaces themselves (interface definitions; concrete VS Code implementations are wired from `extension.ts`)
- `packages/extension/src/commands/` (VS Code command handlers)
- `packages/extension/src/frontend/` (VS Code UI utilities)
- `src/common/webview/` (webview base classes)
- `src/common/state/` (state managers backed by VS Code Memento)
- `src/utils/config/` (wraps `vscode.workspace.getConfiguration`)
- `src/utils/files/workspaceFS.ts`, `storageFS.ts` (wraps `vscode.workspace.fs`)
- `src/auth/` (authentication providers)
- VS Code logging output-channel creation belongs in the extension-host wiring, not in repo-root logger modules.

**Patterns for keeping code platform-agnostic:**

- Reach host services through `platform()` from `@platform` (config, state, log, fs, workspace, storage, secrets) — never import `vscode` in agnostic zones.
- Use `isFile()` / `isDirectory()` from `@common/files/fsEntryType` instead of `vscode.FileType`
- Use `isFileNotFoundError()` from `@common/errors` instead of `instanceof vscode.FileSystemError`
- Return error results instead of calling `vscode.window.show*Message()` from business logic — let the caller (command layer) handle UI
- Use injectable callbacks (like `setExtensionChecker()` in `externalToolDefs.ts`) for platform-specific capabilities needed in agnostic code

### Path Aliases

Common aliases (full list in `tsconfig.json`):

- `@agent/*`, `@commands/*`, `@common/*`, `@frontend/*`, `@utils/*`
- `@model/*`, `@latex/*`, `@logger/*`, `@tools/*`, `@webview/*`
- `@progressView/*`, `@settingsView/*`, `@shared/*`, `@eventBus/*`
- `@replacement/*`, `@housekeeping/*`, `@auth/*`, `@types/*`
- `@platform`, `@platform/*` (platform abstraction layer)

## Adding New Components

### New Command

1. Create file in appropriate `packages/extension/src/commands/` subdirectory
2. Export command function following existing patterns
3. Register in `packages/extension/src/commands.ts`

### New Agent

1. Create YAML definition in `packages/extension/resources/agents/`
2. If needed, implement new agent type in `src/agent/implementations/`

### New Model Provider

1. Create handler in `src/agent/modelHandlers/`
2. Register capabilities and pricing in `src/model/computeModelOptions.ts`

## Release Process

1. Update CHANGELOG.md with user-facing changes (Features, Bug Fixes, Improvements)
2. Build: `npm run build:fast`
3. Create GitHub release with `gh release create`
4. Publish: `vsce publish` and `ovsx publish`

**Changelog guidelines**: Focus on user-visible changes. Never document intermediate bugs fixed within the same PR.
