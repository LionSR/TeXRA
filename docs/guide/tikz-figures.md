# Working with TikZ Figures

TeXRA provides specialized tools for creating and editing [TikZ](https://github.com/pgf-tikz/pgf) vector graphics through the `draw` agent.

For general figure handling (images, PDFs), see [Working with Figures](./working-with-figures.md).

## The `draw` Agent

The `draw` agent can:

- **Create** new TikZ figures from textual descriptions
- **Enhance** existing figures with improvements
- **Fix** errors in TikZ code
- **Add** annotations or labels

### Creating a Figure

1. Select the `draw` agent
2. Choose a capable model (e.g., `o1`, `sonnet45T`, `gemini25p`)
3. Describe what you want
4. Execute

**Example instruction:**

```
Create a TikZ flowchart showing: data collection -> preprocessing ->
feature extraction -> model training -> evaluation. Connect steps with
arrows and add labels.
```

### Enhancing an Existing Figure

1. Select your `.tex` or `.tikz` file as input
2. Select `draw` agent
3. Describe the improvements
4. Execute

## TikZ Extraction

### Automatic Extraction

1. Click the "Auto Extract" dropdown near Figure selection
2. Enable "TikZ Figures"
3. Select your input file(s)

TeXRA will scan for TikZ environments, extract each as a standalone file, and compile previews.

### Manual Extraction

Open Command Palette and run **TeXRA: Extract TikZ Figures from Current File**.

### Via Tool Call

Tool-use agents can invoke `extract_tikz_figures`:

```json
{
  "name": "extract_tikz_figures",
  "arguments": {
    "texPath": "figures/diagrams.tex",
    "compile": true
  }
}
```

Set `compile: false` to skip PDF generation and just get a summary.

## TikZ Compilation

Extracted figures are compiled automatically when using auto-extraction. For manual compilation, run **TeXRA: Compile TikZ Figures from Current File**.

## Configuration

### TikZ Template

Customize the standalone document structure in settings:

```json
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}..."
```

### TikZ Input Directory

If figures depend on custom styles:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs"
```

### Workspace in TEXINPUTS

Enabled by default to help LaTeX find project packages:

```json
"texra.latex.includeWorkspaceInTexinputs": true
```

## Using Reference Figures

Add existing TikZ figures as reference files and mention them in your instructions:

```
Create a neural network diagram similar to the reference file,
but add an attention mechanism. Keep the same visual style.
```

## Next Steps

- [LaTeX Diff](/guide/latex-diff) - Compare document versions
- [LaTeX Tools](/guide/latex-tools) - Other LaTeX integrations
