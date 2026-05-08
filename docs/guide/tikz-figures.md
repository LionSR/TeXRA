# Working with TikZ Figures

[TikZ](https://github.com/pgf-tikz/pgf) is a powerful LaTeX package for creating vector graphics programmatically. It's widely used in academia for diagrams, plots, and technical illustrations because of its high quality and seamless LaTeX integration. Mastering TikZ can feel like learning a new language — TeXRA is here to help.

TeXRA offers specialised features for TikZ, built around the `draw` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and dedicated extraction / compilation tools. This guide focuses on TikZ-specific workflows.

::: tip General Media Handling
For managing other figure types (standard images, PDFs) and general media selection in the UI, see the [Working with Figures](./working-with-figures.md) guide.
:::

## <wa-icon library="texra" name="info"></wa-icon> What is TikZ? (A Brief Intro)

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

## <wa-icon library="texra" name="sparkle"></wa-icon> The `draw` Agent

TeXRA's `draw` agent is designed specifically for TikZ figures — think of it as your AI graphics assistant. It can:

1. <wa-icon library="texra" name="add"></wa-icon> **Create new TikZ figures** from a textual description.
2. <wa-icon library="texra" name="edit"></wa-icon> **Enhance existing figures** with improvements or additions.
3. <wa-icon library="texra" name="wrench"></wa-icon> **Fix errors** in TikZ code.
4. <wa-icon library="texra" name="comment"></wa-icon> **Add annotations** or labels to diagrams.

![TikZ Figure Example](/images/tikz-figure-example.png)

### Creating New Figures

1. Select the agent: `draw` (<wa-icon library="texra" name="sparkle"></wa-icon>).
2. Pick a model (<wa-icon library="texra" name="robot"></wa-icon>) — `sonnet46T`, `opus46T`, `gpt54`, or `gemini31p` are good choices for complex drawings.
3. Provide a detailed description of the figure you want.
4. Click Execute (<wa-icon library="texra" name="play"></wa-icon>).

**Example instruction:**

```
Create a TikZ figure showing a flowchart of the machine learning pipeline
described in Section 2. Include the following steps: data collection,
preprocessing, feature extraction, model training, and evaluation.
Connect the steps with arrows and add appropriate labels.
```

### Enhancing Existing Figures

1. Select the input file (<wa-icon library="texra" name="file-code"></wa-icon>) containing the TikZ code.
2. Select the `draw` agent.
3. Provide instructions for the desired improvements.
4. Execute (<wa-icon library="texra" name="play"></wa-icon>).

**Example instruction:**

```
Enhance the existing TikZ figure to add color coding for different components.
Use blue for input components, green for processing steps, and red for output.
Add a legend explaining the color scheme and improve the layout for better readability.
```

## <wa-icon library="texra" name="file-submodule"></wa-icon> TikZ Extraction

TeXRA can pull TikZ figures out of your LaTeX source for separate processing.

### Automatic Extraction

1. Open the **Auto Extract** dropdown (<wa-icon library="texra" name="wand"></wa-icon>) next to the Media selector.
2. Enable **TikZ Figures**.
3. Select your input file(s) (<wa-icon library="texra" name="file-code"></wa-icon>).
4. Execute your chosen agent (<wa-icon library="texra" name="play"></wa-icon>).

When automatic extraction is enabled, TeXRA will:

1. <wa-icon library="texra" name="search"></wa-icon> Scan your LaTeX documents for `tikzpicture` environments.
2. <wa-icon library="texra" name="file-add"></wa-icon> Extract each figure as a separate file.
3. <wa-icon library="texra" name="output"></wa-icon> Compile the figures to generate PNG previews.
4. <wa-icon library="texra" name="eye"></wa-icon> Make both the TikZ code and previews available to the agent.

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

## <wa-icon library="texra" name="play-circle"></wa-icon> TikZ Compilation

Once extracted, TikZ figures can be compiled into viewable images.

### Automatic Compilation

With automatic extraction on, TeXRA will:

1. Create a standalone LaTeX document per TikZ figure.
2. Compile it with your LaTeX distribution (`latexmk`/`pdflatex`).
3. Convert the PDF to PNG for preview via GraphicsMagick / ImageMagick + Ghostscript.

Missing system dependencies show <wa-icon library="texra" name="warning"></wa-icon> on **Dashboard → LaTeX** (<wa-icon library="texra" name="file-code"></wa-icon>).

### Manual Compilation

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **TeXRA: Compile TikZ Figures from Current File**.

This compiles all extracted figures and generates preview images.

## <wa-icon library="texra" name="settings-gear"></wa-icon> Customising TikZ Processing

Several settings tune how TeXRA handles TikZ. Access them through **Dashboard → LaTeX** (<wa-icon library="texra" name="file-code"></wa-icon>) or VS Code Settings (<wa-icon library="texra" name="gear"></wa-icon>).

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

## <wa-icon library="texra" name="library"></wa-icon> Figure Libraries

The `draw` agent can reuse existing figures as references when creating new ones.

### Using Reference Figures

1. Add previous TikZ figures to the **Reference** section (<wa-icon library="texra" name="book"></wa-icon>).
2. Mention them explicitly in your instructions.
3. Ask the agent to adopt similar styles or approaches.

**Example instruction:**

```
Create a TikZ diagram of a neural network architecture similar to the one in
the reference file, but add an attention mechanism between the encoder and decoder.
Maintain the same visual style and color scheme as the reference figure.
```

## <wa-icon library="texra" name="debug"></wa-icon> Troubleshooting TikZ Issues

### <wa-icon library="texra" name="error"></wa-icon> Compilation Errors

1. Check the LaTeX log for specific error messages (build directory).
2. Verify required TikZ libraries are in the template.
3. Ensure your LaTeX distribution has the necessary packages.
4. Simplify complex figures that might exceed compiler limits.

### <wa-icon library="texra" name="package"></wa-icon> Missing Packages

1. Install the required packages through your LaTeX distribution manager.
2. Add the packages to your TikZ template.
3. Ensure package paths are in `TEXINPUTS`.

### <wa-icon library="texra" name="symbol-ruler"></wa-icon> Figure Size Issues

1. Adjust the `border` parameter in the standalone document class.
2. Scale the figure using TikZ's `scale` option.
3. Resize specific elements rather than the entire figure.

## <wa-icon library="texra" name="lightbulb"></wa-icon> Best Practices

### Effective TikZ Instructions

For best results with `draw`:

1. <wa-icon library="texra" name="target"></wa-icon> **Be specific** — describe all elements and their relationships.
2. <wa-icon library="texra" name="info"></wa-icon> **Provide context** — include purpose and intended audience.
3. <wa-icon library="texra" name="symbol-color"></wa-icon> **Specify style** — mention colours, line styles, text formatting.
4. <wa-icon library="texra" name="link"></wa-icon> **Reference examples** — point to similar figures when possible.

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
