# File Management

TeXRA organizes files into categories for agent processing.

## File Categories

| Category | Purpose | Extensions |
|----------|---------|------------|
| **Input** | Primary files for processing | `.tex`, `.txt`, `.md` |
| **Reference** | Examples or context | Any document |
| **Auxiliary** | Supporting files | `.cls`, `.sty`, `.bib` |
| **Media** | Figures and audio | Images, PDFs, audio (see [Working with Figures](./working-with-figures.md)) |

## File Selection Interface

Each category has:
- **Dropdown**: Select a single file
- **Current Button**: Select the open file in VS Code
- **Empty Button**: Clear selection
- **Multiple Toggle (down arrow)**: Switch to multi-file mode
- **Refresh Button**: Update file list

### Multiple File Selection

1. Click the toggle to expand
2. Use "Add" to add files
3. Remove with the "-" button
4. Drag to reorder
5. "Empty List" clears all

**Add Opened Files**: Quickly add all currently open VS Code files matching the category.

## Output File Naming

TeXRA names outputs as:

```
original_agent_r0_model.extension
```

Example: `paper.tex` with `polish` agent and `sonnet45` becomes `paper_polish_r0_sonnet45.tex`.

Reflection rounds produce `_r1_` files.

## File Management Commands

| Command | Description |
|---------|-------------|
| **Pack** | Archive outputs to `History` folder |
| **Clean** | Remove outputs for current agent/model |

## Task Run Storage

Each agent run creates a folder:

```
.vscode/texra/taskRuns/<executionId>/
```

Contains intermediate artifacts; safe to delete.

## LaTeX Project Structure

TeXRA works with standard LaTeX layouts:

```
project/
├── main.tex
├── chapters/
│   ├── intro.tex
│   └── methodology.tex
├── figures/
└── bibliography.bib
```

## LaTeX Workshop Integration

TeXRA auto-configures [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) on first activation (if not already set):

- Output to `build/` subdirectory
- Robust compilation arguments
- Word wrap for `.tex` files

## Configuration

Customize file extensions in settings:

```json
"texra.files.included.inputExtensions": [".tex", ".md"],
"texra.files.ignored.directories": ["build", "node_modules"]
```

See [Configuration](./configuration.md) for full options.

## Next Steps

- [LaTeX Tools](/guide/latex-tools) - LaTeX processing tools
- [LaTeX Diff](/guide/latex-diff) - Compare document versions
- [Multiple Outputs](/guide/multiple-output) - Handle multi-file outputs
