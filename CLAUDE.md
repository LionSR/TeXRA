# CLAUDE.md

Guidance for Claude Code when working with this repository. For detailed coding conventions and patterns, see [AGENTS.md](./AGENTS.md).

## Project Overview

TeXRA is a VS Code extension that serves as an AI-powered LaTeX research assistant. It uses Large Language Models to help academics with writing, research, and document processing.

## Development Commands

```bash
# Install dependencies
npm install

# Development build with watch mode
npm run watch

# Production build
npm run package

# Build VSIX extension file
npm run build
# Creates: releases/texra-{version}.vsix

# Run all tests with linting
npm test

# Run linting only
npm run lint

# Format code with Prettier
npm run format
```

## Architecture Overview

### Agent System

The core of TeXRA is its agent architecture in `src/agent/`:

- **Core interfaces** define agent behavior and state management
- **Implementations** provide reasoning strategies (Direct, Chain-of-Thought, Merge, Workflow)
- **Model handlers** abstract AI provider APIs (Anthropic, OpenAI, Google, etc.)
- Agents are configured via YAML files in `resources/agents/`

`_multiple` YAML files provide alternate prompts for agents supporting multiple outputs. This preference only applies to the initial agent; parent definitions via `inherits` use base files.

### Source Organization

Key directories in `src/`:

- `agent/` - Agent core, implementations, model handlers, runtime, tool-use
  - `implementations/flows/` - PocketFlow-based flow implementations (reflection, tool-use)
- `commands/` - Commands organized by domain (see below)
- `common/` - Backend-only helpers (errors, state, files, webview base classes)
- `frontend/` - Extension-host utilities for shared UI flows
- `utils/` - Utilities shared between extension host and webviews
- `tools/` - Tool implementations for tool-use agents
- `model/` - Model configuration, registry, and providers
- `latex/` - LaTeX processing (formatting, diff, TikZ, PDF)
- `webview/` - Main agent interaction interface
- `progressView/` - Task tracking board
- `historyView/` - Execution history browser
- `profileView/` - Agent profile/settings view
- `explorer/` - VS Code file explorer integration
- `logger/` - Logging infrastructure
- `eventBus/` - Progress event system
- `replacement/` - Text cleanup rules

Key documentation in `docs/`:

- `pocketflow/` - PocketFlow framework documentation (core abstractions, design patterns, utility functions)

### Commands (`src/commands/`)

- `agent/` - Running and managing agents, merge operations
- `api/` - API key management
- `auth/` - Authentication commands
- `files/` - File selection and management
- `git/` - Git integration
- `history/` - State restoration and history browser
- `housekeeping/` - Cleanup, packing, and utilities
- `latex/` - LaTeX operations (diff, figures, etc.)
- `progress/` - Progress board management
- `system/` - Help, settings, tests, XML/YAML utilities, editor commands
- `tests/` - Test commands
- `wolfram/` - Wolfram Alpha queries and script utilities

### Schema and Type Guidelines

Use Zod schemas as the single source of truth for data structures:

- **Define schemas first**, then derive TypeScript types using `z.infer<typeof Schema>`
- **Use schema composition** (`.extend()`, `.pick()`) instead of duplicating field definitions
- **Avoid `z.custom<T>()`** when a proper schema exists—prefer `z.discriminatedUnion()` for union types
- **Co-locate types with schemas** in the same file for maintainability
- **Add compile-time assertions** (using `satisfies`) when schemas must stay synchronized with external types

This project uses **Zod v4**. See AGENTS.md for idiomatic Zod v4 patterns including `.prefault()`, `.catch()`, and `.nullish()` for tool schemas.

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

### Path Aliases

Common aliases (full list in `tsconfig.json`):

- `@agent/*`, `@commands/*`, `@common/*`, `@frontend/*`, `@utils/*`
- `@model/*`, `@latex/*`, `@logger/*`, `@tools/*`, `@webview/*`
- `@progressView/*`, `@historyView/*`, `@eventBus/*`, `@replacement/*`

## Adding New Components

### New Command

1. Create file in appropriate `src/commands/` subdirectory
2. Export command function following existing patterns
3. Register in `src/commands/index.ts`

### New Agent

1. Create YAML definition in `resources/agents/`
2. If needed, implement new agent type in `src/agent/implementations/`

### New Model Provider

1. Create handler in `src/agent/modelHandlers/`
2. Add provider config in `src/model/providers/`
3. Register in `src/model/ModelRegistry.ts`

## Release Process

1. Update CHANGELOG.md with user-facing changes (Features, Bug Fixes, Improvements)
2. Build: `npm run build`
3. Create GitHub release with `gh release create`
4. Publish: `vsce publish` and `ovsx publish`

**Changelog guidelines**: Focus on user-visible changes. Never document intermediate bugs fixed within the same PR.
