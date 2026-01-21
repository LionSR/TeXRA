# Tools Overview

Tool-use agents in TeXRA have access to various capabilities for research, file manipulation, and computation.

## Capability Categories

### File Operations

Agents can read, write, and edit files in your workspace:

- **Reading**: View file contents, including PDFs and images
- **Writing**: Create or overwrite files
- **Editing**: Make targeted changes to existing files
- **Searching**: Find files by name patterns or search content

### Literature Discovery

Research-oriented agents can find academic papers:

- **arXiv**: Search for preprints, get metadata, download source files
- **Crossref**: Look up publications by DOI or search for works
- **Web**: Fetch webpage content and perform web searches

### LaTeX Processing

Specialized tools for working with LaTeX documents:

- **Figure extraction**: List and retrieve figures from documents
- **Bibliography**: Extract BibTeX entries for citations used
- **TikZ figures**: Discover and compile TikZ diagrams
- **Word count**: Get document statistics

### Computation

The `research` agent has access to:

- **Wolfram Language**: Symbolic math, numerical computation, plotting

### Lean 4

The `lean` agent integrates with VS Code's Lean extension:

- **Diagnostics**: Real-time errors and warnings
- **Inspection**: View goal state and types at cursor
- **Project commands**: Build, clean, fetch dependencies
- **Mathlib search**: Find lemmas by type signature

## Which Agent Has Which Capabilities?

| Agent | Files | Literature | LaTeX | Compute | Lean |
|-------|-------|------------|-------|---------|------|
| `chat` | Read/Write | - | - | - | - |
| `ask` | Read-only | - | - | - | - |
| `search` | Read-only | Full | Extract | - | - |
| `research` | Read/Write | - | Extract | Wolfram | - |
| `discuss` | Read-only | Full | Extract | - | - |
| `lean` | Read/Write | - | - | - | Full |

## For Custom Agent Authors

If you're creating custom tool-use agents, see the [Custom Agents](../guide/custom-agents) guide for the list of available tool names you can include in your agent's `tools` configuration.
