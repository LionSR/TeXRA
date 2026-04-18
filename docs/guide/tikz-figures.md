# Working with TikZ Figures

[TikZ](https://github.com/pgf-tikz/pgf) is a powerful LaTeX package for creating vector graphics programmatically. It's widely used in academia for diagrams, plots, and technical illustrations because of its high quality and seamless LaTeX integration. Mastering TikZ can feel like learning a new language — TeXRA is here to help.

TeXRA offers specialised features for TikZ, built around the `draw` agent (<i class="codicon codicon-sparkle"></i>) and dedicated extraction / compilation tools. This guide focuses on TikZ-specific workflows.

::: tip General Media Handling
For managing other figure types (standard images, PDFs) and general media selection in the UI, see the [Working with Figures](./working-with-figures.md) guide.
:::

## <i class="codicon codicon-info"></i> What is TikZ? (A Brief Intro)

Instead of using a graphical editor, TikZ lets you describe graphics with commands inside your LaTeX document. For example:

```latex
\documentclass[tikz, border=2mm]{standalone}
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
  \draw[blue, thick] (0,0) circle (1cm);
  \node at (0,0) {Hello!};
\end{tikzpicture}
\end{document}
```

This code draws a blue circle with text inside. TeXRA's tools help manage and generate this kind of code.

## <i class="codicon codicon-sparkle"></i> The `draw` Agent

TeXRA's `draw` agent is designed specifically for TikZ figures — think of it as your AI graphics assistant. It can:

1. <i class="codicon codicon-add"></i> **Create new TikZ figures** from a textual description.
2. <i class="codicon codicon-edit"></i> **Enhance existing figures** with improvements or additions.
3. <i class="codicon codicon-wrench"></i> **Fix errors** in TikZ code.
4. <i class="codicon codicon-comment"></i> **Add annotations** or labels to diagrams.

![TikZ Figure Example](/images/tikz-figure-example.png)

### Creating New Figures

1. Select the agent: `draw` (<i class="codicon codicon-sparkle"></i>).
2. Pick a model (<i class="codicon codicon-robot"></i>) — `sonnet46T`, `opus46T`, `gpt54`, or `gemini31p` are good choices for complex drawings.
3. Provide a detailed description of the figure you want.
4. Click Execute (<i class="codicon codicon-play"></i>).

**Example instruction:**

```
Create a TikZ figure showing a flowchart of the machine learning pipeline
described in Section 2. Include the following steps: data collection,
preprocessing, feature extraction, model training, and evaluation.
Connect the steps with arrows and add appropriate labels.
```

### Enhancing Existing Figures

1. Select the input file (<i class="codicon codicon-file-code"></i>) containing the TikZ code.
2. Select the `draw` agent.
3. Provide instructions for the desired improvements.
4. Execute (<i class="codicon codicon-play"></i>).

**Example instruction:**

```
Enhance the existing TikZ figure to add color coding for different components.
Use blue for input components, green for processing steps, and red for output.
Add a legend explaining the color scheme and improve the layout for better readability.
```

## <i class="codicon codicon-file-submodule"></i> TikZ Extraction

TeXRA can pull TikZ figures out of your LaTeX source for separate processing.

### Automatic Extraction

1. Open the **Auto Extract** dropdown (<i class="codicon codicon-wand"></i>) next to the Media selector.
2. Enable **TikZ Figures**.
3. Select your input file(s) (<i class="codicon codicon-file-code"></i>).
4. Execute your chosen agent (<i class="codicon codicon-play"></i>).

When automatic extraction is enabled, TeXRA will:

1. <i class="codicon codicon-search"></i> Scan your LaTeX documents for `tikzpicture` environments.
2. <i class="codicon codicon-file-add"></i> Extract each figure as a separate file.
3. <i class="codicon codicon-output"></i> Compile the figures to generate PNG previews.
4. <i class="codicon codicon-eye"></i> Make both the TikZ code and previews available to the agent.

### Manual Extraction Commands

You can also extract TikZ figures from the Command Palette:

1. Open a LaTeX file containing TikZ figures.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **TeXRA: Extract TikZ Figures from Current File**.

This creates standalone files for each TikZ figure in your document.

### Agent Tool Calls

Tool-use agents can invoke `extract_tikz_figures` to perform the same discovery and optional compilation steps programmatically:

```json
{
  "name": "extract_tikz_figures",
  "arguments": {
    "texPath": "figures/diagrams.tex",
    "compile": true
  }
}
```

With `compile: true` the tool emits standalone PDFs (one per figure) and attaches them so multimodal models can read the binary output directly. Set `compile: false` if you only need a summary of labels or plan to edit the extracted TikZ code yourself.

## <i class="codicon codicon-play-circle"></i> TikZ Compilation

Once extracted, TikZ figures can be compiled into viewable images.

### Automatic Compilation

With automatic extraction on, TeXRA will:

1. Create a standalone LaTeX document per TikZ figure.
2. Compile it with your LaTeX distribution (`latexmk`/`pdflatex`).
3. Convert the PDF to PNG for preview via GraphicsMagick / ImageMagick + Ghostscript.

Missing system dependencies show <i class="codicon codicon-warning"></i> on **Dashboard → LaTeX** (<i class="codicon codicon-file-code"></i>).

### Manual Compilation

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **TeXRA: Compile TikZ Figures from Current File**.

This compiles all extracted figures and generates preview images.

## <i class="codicon codicon-settings-gear"></i> Customising TikZ Processing

Several settings tune how TeXRA handles TikZ. Access them through **Dashboard → LaTeX** (<i class="codicon codicon-file-code"></i>) or VS Code Settings (<i class="codicon codicon-gear"></i>).

### TikZ Template

The standalone document structure TeXRA uses for each extracted figure:

```json
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

Customise this template to include additional packages or settings your figures need.

### TikZ Input Directory

If your TikZ figures depend on custom styles or macros, specify an input directory:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs"
```

The directory is added to the LaTeX search path when compiling figures.

### Including Workspace in `TEXINPUTS`

By default TeXRA adds your workspace root to `TEXINPUTS`:

```json
"texra.latex.includeWorkspaceInTexinputs": true
```

This helps LaTeX locate packages and styles stored elsewhere in the project.

## <i class="codicon codicon-library"></i> Figure Libraries

The `draw` agent can reuse existing figures as references when creating new ones.

### Using Reference Figures

1. Add previous TikZ figures to the **Reference** section (<i class="codicon codicon-book"></i>).
2. Mention them explicitly in your instructions.
3. Ask the agent to adopt similar styles or approaches.

**Example instruction:**

```
Create a TikZ diagram of a neural network architecture similar to the one in
the reference file, but add an attention mechanism between the encoder and decoder.
Maintain the same visual style and color scheme as the reference figure.
```

## <i class="codicon codicon-debug"></i> Troubleshooting TikZ Issues

### <i class="codicon codicon-error"></i> Compilation Errors

1. Check the LaTeX log for specific error messages (build directory).
2. Verify required TikZ libraries are in the template.
3. Ensure your LaTeX distribution has the necessary packages.
4. Simplify complex figures that might exceed compiler limits.

### <i class="codicon codicon-package"></i> Missing Packages

1. Install the required packages through your LaTeX distribution manager.
2. Add the packages to your TikZ template.
3. Ensure package paths are in `TEXINPUTS`.

### <i class="codicon codicon-symbol-ruler"></i> Figure Size Issues

1. Adjust the `border` parameter in the standalone document class.
2. Scale the figure using TikZ's `scale` option.
3. Resize specific elements rather than the entire figure.

## <i class="codicon codicon-lightbulb"></i> Best Practices

### Effective TikZ Instructions

For best results with `draw`:

1. <i class="codicon codicon-target"></i> **Be specific** — describe all elements and their relationships.
2. <i class="codicon codicon-info"></i> **Provide context** — include purpose and intended audience.
3. <i class="codicon codicon-symbol-color"></i> **Specify style** — mention colours, line styles, text formatting.
4. <i class="codicon codicon-link"></i> **Reference examples** — point to similar figures when possible.

### Figure Organisation

1. Use consistent naming conventions for figures.
2. Store extracted figures in a dedicated directory.
3. Include comments in TikZ code explaining complex parts.
4. Maintain a library of reusable figure components.

### Performance Considerations

TikZ compilation can be resource-intensive:

1. Split very complex figures into multiple smaller ones.
2. Use the `external` library for caching compiled figures.
3. Keep simplified versions for drafts; full detail for finals.

## Next Steps

- [LaTeX Diff](./latex-diff.md) — compare document versions including figures
- [LaTeX Tools](./latex-tools.md) — the full set of LaTeX tools TeXRA plugs into
- [Best Practices](./best-practices.md) — general tips for working with TeXRA
