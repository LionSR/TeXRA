# Working with TikZ Figures

[TikZ](https://github.com/pgf-tikz/pgf) is a powerful LaTeX package for creating vector graphics programmatically. It's widely used in academia for diagrams, plots, and technical illustrations due to its high quality and seamless LaTeX integration. While mastering TikZ can feel like learning a new language, TeXRA is here to help!

TeXRA offers specialized features for working with TikZ, leveraging the `draw` agent and specific extraction/compilation tools. This guide focuses on TikZ-specific workflows.

::: tip General Media Handling
For information on managing other types of figures (like standard images or PDFs) and general media selection in the UI, see the [Working with Figures](./working-with-figures.md) guide.
:::

## What is TikZ? (A Brief Intro)

Instead of using a graphical editor, TikZ lets you describe graphics using commands within your LaTeX document. For example:

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

## The `draw` Agent

TeXRA's `draw` agent is specifically designed to work with TikZ figures (think of it as your AI graphics assistant). It can:

1. **Create new TikZ figures** based on textual descriptions.
2. **Enhance existing figures** with improvements or additions.
3. **Fix errors** or issues in TikZ code.
4. **Add annotations** or labels to diagrams.

![TikZ Figure Example](/images/tikz-figure-example.png)

### Creating New Figures

To create a new TikZ figure:

1. Select the agent: `draw`
2. Choose a model (Models like `o1`, `sonnet37T`, or `gemini25p` are often good choices for complex drawing tasks).
3. Provide a detailed description of the desired figure
4. Execute the agent

**Example instruction:**

```
Create a TikZ figure showing a flowchart of the machine learning pipeline
described in Section 2. Include the following steps: data collection,
preprocessing, feature extraction, model training, and evaluation.
Connect the steps with arrows and add appropriate labels.
```

### Enhancing Existing Figures

To enhance an existing figure:

1. Select the input file containing the TikZ code
2. Select the `draw` agent
3. Provide instructions for the desired improvements
4. Execute the agent

**Example instruction:**

```

Enhance the existing TikZ figure to add color coding for different components.
Use blue for input components, green for processing steps, and red for output.
Add a legend explaining the color scheme and improve the layout for better readability.
```

## TikZ Extraction

TeXRA can automatically extract TikZ figures from your LaTeX documents for separate processing and management.

### Automatic Extraction

To enable automatic TikZ extraction:

1. Click on the "Auto Extract" dropdown near the Figure selection
2. Enable "TikZ Figures"
3. Select your input file(s)
4. Execute your chosen agent

When automatic extraction is enabled, TeXRA will:

1. Scan your LaTeX documents for TikZ environments
2. Extract each figure as a separate file
3. Compile the figures to create PNG previews
4. Make both the TikZ code and previews available to the agent

### Manual Extraction Commands

You can also extract TikZ figures manually using VSCode commands:

1. Open a LaTeX file containing TikZ figures
2. Open the Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS)
3. Run "TeXRA: Extract TikZ Figures from Current File"

This will create standalone files for each TikZ figure in your document.

## TikZ Compilation

Once extracted, TikZ figures can be compiled into viewable images:

### Automatic Compilation

When using the automatic extraction feature, TeXRA will:

1. Create a standalone LaTeX document for each TikZ figure
2. Compile it using your LaTeX distribution
3. Convert the resulting PDF to PNG for viewing

### Manual Compilation

You can manually compile extracted figures:

1. Open the Command Palette
2. Run "TeXRA: Compile TikZ Figures from Current File"

This will compile all extracted figures and generate preview images.

## Customizing TikZ Processing

You can customize how TeXRA handles TikZ figures through several settings:

### TikZ Template

The TikZ template determines the standalone document structure used for extracted figures:

```json
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

Customize this template to include additional packages or settings required by your figures.

### TikZ Input Directory

If your TikZ figures depend on custom styles or macros, you can specify an input directory:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs"
```

This directory will be added to the LaTeX search path when compiling figures.

### Including Workspace in TEXINPUTS

By default, TeXRA includes your workspace root in the TEXINPUTS environment variable:

```json
"texra.latex.includeWorkspaceInTexinputs": true
```

This helps LaTeX find packages and styles located elsewhere in your project.

## Figure Libraries

The `draw` agent can utilize existing figures as references when creating new ones.

### Using Reference Figures

To leverage existing figures as references:

1. Add previous TikZ figures as reference files
2. Mention them specifically in your instructions
3. Ask the agent to adopt similar styles or approaches

**Example instruction:**

```
Create a TikZ diagram of a neural network architecture similar to the one in
the reference file, but add an attention mechanism between the encoder and decoder.
Maintain the same visual style and color scheme as the reference figure.
```

## Troubleshooting TikZ Issues

### Compilation Errors

If TikZ figures fail to compile:

1. Check the LaTeX log for specific error messages (look in the build directory)
2. Verify that all required TikZ libraries are included in the template
3. Ensure your LaTeX distribution has the necessary packages
4. Try simplifying complex figures that might exceed compiler limits

### Missing Packages

If compilation fails due to missing packages:

1. Install the required packages through your LaTeX distribution manager
2. Add the packages to your TikZ template
3. Ensure package paths are correctly included in TEXINPUTS

### Figure Size Issues

For figures that are too large or small:

1. Adjust the `border` parameter in the standalone document class
2. Scale the figure using TikZ's `scale` option
3. Resize specific elements rather than the entire figure

## Best Practices

### Effective TikZ Instructions

For best results with the `draw` agent:

1. **Be Specific**: Clearly describe all elements and their relationships
2. **Provide Context**: Include the purpose and intended audience
3. **Specify Style**: Mention colors, line styles, and text formatting
4. **Reference Examples**: Point to similar figures when possible

### Figure Organization

Organize your TikZ figures effectively:

1. Use consistent naming conventions for figures
2. Store extracted figures in a dedicated directory
3. Include comments in TikZ code explaining complex parts
4. Maintain a library of reusable figure components

### Performance Considerations

TikZ compilation can be resource-intensive:

1. Split very complex figures into multiple smaller ones
2. Use the `external` library for caching compiled figures
3. Consider simplified versions for drafts and detailed versions for final documents

## Next Steps

Now that you understand how to work with TikZ figures in TeXRA, you may want to learn about:

- [LaTeX Diff](/guide/latex-diff) - Learn how to compare document versions including figures
- [Tool Integration](/guide/tool-integration) - Discover other tools TeXRA integrates with
- [Best Practices](/reference/best-practices) - Learn general best practices for working with TeXRA
