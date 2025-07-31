# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeXRA is a VS Code extension that serves as an AI-powered LaTeX research assistant. It uses Large Language Models to help academics with writing, research, and document processing.

**Documentation Note**: When updating the CHANGELOG or release notes, focus on user-facing features, bug fixes, and improvements that directly impact the user experience.

## Development Commands

### Build and Development

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
```

### Testing and Quality

```bash
# Run all tests with linting
npm test

# Run linting only
npm run lint

# Format code with Prettier
npm run format

# Compile tests
npm run compile-tests

# Watch tests during development
npm run watch-tests
```

## Architecture Overview

### Agent System

The core of TeXRA is its agent architecture located in `src/agent/`:

- **Core interfaces** define agent behavior and state management
- **Implementations** provide different reasoning strategies (Direct, Chain-of-Thought, Merge, Reflection)
- **Model handlers** abstract different AI provider APIs (Anthropic, OpenAI, Google, etc.)
- Agents are configured via YAML files in `resources/agents/`

### Command Organization

Commands in `src/commands/` are organized by domain:

- `agent/` - running and managing agents, including merge operations
- `api/` - API key management
- `files/` - File selection and management
- `git/` - Git integration
- `housekeeping/` - cleanup, packing, and related utilities
- `latex/` - LaTeX-specific operations (diff, figures, etc.)
- `history/` - state restoration and history browser
- `progress/` - Progress board management
- `wolfram/` - Wolfram Alpha queries and script utilities
- `system/` - help, settings, tests, XML/YAML utilities, and editor commands

### WebView Components

Three main webview interfaces:

- **Main webview** (`src/webview/`) - Primary agent interaction interface
- **Progress view** (`src/progressView/`) - Task tracking board
- **History view** (`src/historyView/`) - Execution history browser

### LaTeX Processing

The `src/latex/` module provides:

- Document formatting with latexindent and tex-fmt
- LaTeX diff generation
- TikZ figure extraction and compilation
- PDF processing and conversion
- Word counting and analysis

### Path Aliases

The project uses TypeScript path aliases for cleaner imports:

- `@agent/*` → `src/agent/*`
- `@utils/*` → `src/utils/*`
- `@latex/*` → `src/latex/*`
- `@commands/*` → `src/commands/*`
- `@common/*` → `src/common/*`

## Key Design Principles

1. **Modular Architecture**: Each feature domain has its own module with clear boundaries
2. **Configuration-Driven**: Extensive VS Code settings allow users to customize behavior
3. **Multi-Model Support**: Unified interface for different AI providers
4. **Error Handling**: Comprehensive error handling with user-friendly messages
5. **Extensibility**: New agents can be added via YAML configuration without code changes

## Common Development Tasks

### Adding a New Command

1. Create command file in appropriate `src/commands/` subdirectory
2. Export command function following existing patterns
3. Register in `src/commands/index.ts`

### Adding a New Agent Type

1. Create YAML definition in `resources/agents/`
2. If needed, implement new agent type in `src/agent/implementations/`
3. Update agent factory if creating new implementation

### Working with WebViews

1. WebView code is in respective directories (`webview/`, `progressView/`, `historyView/`)
2. Common modules are shared via `src/common/modules/`
3. Use message passing for communication between extension and webview

### Model Integration

To add support for a new AI provider:

1. Create model handler in `src/agent/modelHandlers/`
2. Add provider configuration in `src/model/providers/`
3. Update model registry in `src/model/`
