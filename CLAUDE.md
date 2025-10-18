# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeXRA is a VS Code extension that serves as an AI-powered LaTeX research assistant. It uses Large Language Models to help academics with writing, research, and document processing.

**Documentation Note**: When updating the CHANGELOG or release notes, focus on user-facing features, bug fixes, and improvements that directly impact the user experience. Never document intermediate bugs that were introduced and fixed within the same PR - only document issues that affected released versions.

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
- **Implementations** provide different reasoning strategies (Direct, Chain-of-Thought, Merge, Workflow)
- **Model handlers** abstract different AI provider APIs (Anthropic, OpenAI, Google, etc.)
- Agents are configured via YAML files in `resources/agents/`

**Multiple-output agent variants**: `_multiple` YAML files may provide alternate
prompts for agents that support multiple outputs. The preference for these
variants is only applied to the initial agent requested by the runtime. Parent
definitions loaded through the `inherits` field always use their base files so
that shared prompts and defaults remain consistent across the inheritance chain.

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

**Dependency Management Note**: WebViews load complex packages (markdown-it, KaTeX, highlight.js) from CDN to avoid transitive dependency issues and reduce extension size. Simple standalone packages (split.js, codicons) are bundled locally.

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

## Release Process

When creating a new release:

1. **Update CHANGELOG.md** with user-facing changes
   - Follow the format: `## [x.x.x] - YYYY-MM-DD`
   - Group changes into Features, Bug Fixes, and Improvements
   - Focus only on user-visible changes
   - **Writing Standards:**
     - Keep entries concise and focused on what users will experience
     - Don't mention intermediate bugs that were introduced and fixed within the same PR
     - Don't include implementation details unless they directly affect usage
     - Use present tense for features ("Add", "Support", "Enable")
     - Example: "Add real-time streaming display for model reasoning" ✓
     - Avoid: "Fix thinking blocks not appearing as subgroups" ✗ (if this bug wasn't in production)

2. **Build the VSIX package**

   ```bash
   npm run build
   # Creates: releases/texra-{version}.vsix
   ```

3. **Create GitHub release**

   ```bash
   gh release create v{version} \
     --title "TeXRA v{version}" \
     --notes "## What's Changed\n\n{release notes}\n\n**Full Changelog**: https://github.com/LionSR/TeXRA/compare/v{prev}...v{version}" \
     releases/texra-{version}.vsix
   ```

4. **Publish to VS Code Marketplace**

   ```bash
   vsce publish
   ```

5. Publish to Open VSX Marketplace

   ```bash
   ovsx publish
   ```

6. **Version bump**: A GitHub Action automatically creates a PR to bump the version after release
