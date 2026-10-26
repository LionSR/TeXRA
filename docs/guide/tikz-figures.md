# Working with TikZ figures

<script setup>
import TikzTroubleshootCards from '../.vitepress/components/TikzTroubleshootCards.vue';
</script>

[TikZ](https://github.com/pgf-tikz/pgf) is a LaTeX package for creating vector graphics programmatically. It is widely used in academia for diagrams, plots, and technical illustrations because of its output quality and its integration with LaTeX. Learning TikZ can feel like learning a new language. TeXRA helps with that, so the figures that illustrate a derivation or a result take less of your time than the theory itself.

TeXRA offers features built for TikZ, centered on agents with tools, which write TikZ, compile it, and visually verify the result, together with dedicated extraction and compilation tools. This guide covers the TikZ-specific workflows.

::: info No dedicated `draw` agent
Earlier versions of TeXRA shipped a standalone `draw` agent. Figure generation
is now handled by the general agents `research` and `presenter`, which
can write TikZ, compile it, inspect the rendered output, and iterate until it
looks right.
:::

::: tip General media handling
For other figure types (standard images, PDFs) and media selection in the UI, read the [Working with figures](./working-with-figures.md) guide.
:::

## <wa-icon library="texra" name="sparkle"></wa-icon> Generating TikZ with agents

Agents with tools (`research` or `presenter`) can create new TikZ figures from a description, refine existing diagrams, fix compilation errors, and inspect the rendered PDF in a loop until the layout is clean:

<ToolCallPanel
  title="research"
  icon="sparkle"
  caption="drawing a TikZ figure · iterating · this run"
  :calls="[
    { state: 'done', verb: 'write_file', target: 'figures/ml-pipeline.tex', effect: 'Writes a first draft of the flowchart' },
    { state: 'done', verb: 'bash', target: 'latexmk ml-pipeline.tex', effect: 'pdflatex OK → renders the standalone PDF' },
    { state: 'done', verb: 'read_file', target: 'ml-pipeline.pdf', effect: 'Sees nodes overlap, one arrow misaligned' },
    { state: 'active', verb: 'edit_file', target: 'figures/ml-pipeline.tex', effect: 'Adjusts node spacing and arrow anchors, then recompiles' },
  ]"
/>

<p class="hero-caption">The agent writes, compiles, looks at the rendered PDF, and loops back to fix what it sees: a self-correcting draw cycle, not a one-shot generation.</p>

![TikZ Figure Example](/images/tikz-figure-example.png)

### Creating new figures

1. Select an agent, `research` or `presenter` (<wa-icon library="texra" name="sparkle"></wa-icon>).
2. Pick a vision-capable model (<wa-icon library="texra" name="robot"></wa-icon>). `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol`, and `google/gemini-3.1-pro-preview` are good choices for complex drawings.
3. Describe the figure you want in detail.
4. Select **Run agent** (<wa-icon library="texra" name="arrow-up"></wa-icon>).

From the CLI, the same draw, compile, and inspect loop shown below runs
headlessly (`texra run` takes any agent: one without a document task, like
`research`, runs with your `--instruction`):

```bash
texra run research --input figures.tex \
  --instruction "Create a TikZ flowchart of the ML pipeline in Section 2."
```

**Example instruction:**

```
Create a TikZ figure showing a flowchart of the machine learning pipeline
described in Section 2. Include the following steps: data collection,
preprocessing, feature extraction, model training, and evaluation.
Connect the steps with arrows and add appropriate labels.
```

### Enhancing existing figures

1. Select an agent (`research` or `presenter`).
2. Describe the improvements you want, and name the file that holds the TikZ code; the agent reads it with its own tools.
3. Select **Run agent** (<wa-icon library="texra" name="arrow-up"></wa-icon>).

**Example instruction:**

```
Enhance the existing TikZ figure to add color coding for different components.
Use blue for input components, green for processing steps, and red for output.
Add a legend explaining the color scheme and improve the layout for better readability.
```

## <wa-icon library="texra" name="file-submodule"></wa-icon> TikZ extraction

TeXRA can pull TikZ figures out of your LaTeX source for separate processing.

### Automatic extraction

1. Open the **Auto Extract** dropdown (<wa-icon library="texra" name="wand"></wa-icon>) next to the Media selector.
2. Enable **TikZ Figures**.
3. Select your input file(s) (<wa-icon library="texra" name="file-code"></wa-icon>).
4. Execute your chosen agent (<wa-icon library="texra" name="play"></wa-icon>).

<DropdownMenu
  label="Media · Auto-extract"
  value="Auto Extract"
  valueIcon="wand"
  maxWidth="320px"
  :groups="[{ items: [
    { name: 'Figures', checkbox: true, checked: false },
    { name: 'TikZ Figures', checkbox: true, checked: true },
    { name: 'Compile Input PDF', checkbox: true, checked: false },
  ] }]"
/>

<p class="hero-caption">Open the wand <strong>Auto-extract</strong> menu in the Media group and check <strong>TikZ Figures</strong>. Every <code>tikzpicture</code> in your selected files is then pulled out on the next run.</p>

When automatic extraction is enabled, each `tikzpicture` in your selected files is extracted into a standalone `.tex` document, compiled to PDF with `latexmk` / `pdflatex`, and attached to the prompt alongside the source code:

<FlowSteps :steps="[
  { icon: 'file-code', title: 'Source', desc: 'One .tex file with several tikzpicture environments.', chips: [{ text: 'diagrams.tex', variant: 'info', icon: 'file-code' }] },
  { icon: 'file-submodule', title: 'Extract', desc: 'A standalone LaTeX document per figure.', chips: [{ text: 'fig1.tex', variant: 'neutral' }, { text: 'fig2.tex', variant: 'neutral' }, { text: 'fig3.tex', variant: 'neutral' }] },
  { icon: 'play-circle', title: 'Compile', desc: 'latexmk / pdflatex builds each standalone.', chips: [{ text: '3 PDFs', variant: 'warning', icon: 'file-pdf' }] },
  { icon: 'output', title: 'Attach', desc: 'Models with native PDF support read the PDFs directly; others get rasterised PNGs via GraphicsMagick / ImageMagick + Ghostscript.', chips: [{ text: 'PDF or PNG', variant: 'success', icon: 'eye' }] },
  { icon: 'robot', title: 'Agent', desc: 'Sees both the TikZ code and the rendered output.', chips: [{ text: 'code + image', variant: 'accent' }] }
]" />

<p class="hero-caption">The extract, compile, attach pipeline: each <code>tikzpicture</code> becomes its own standalone document and PDF. Rasterization to PNG, only for models without native PDF support, needs GraphicsMagick / ImageMagick + Ghostscript.</p>

Missing system dependencies show <wa-icon library="texra" name="warning"></wa-icon> on **Settings → LaTeX** (<wa-icon library="texra" name="file-code"></wa-icon>).

### Compile from the Command Palette

You can also extract and compile TikZ figures manually from the Command Palette:

1. Open a LaTeX file containing TikZ figures.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **TeXRA: Compile TikZ Figures from Current File**.

This wraps each TikZ figure in a standalone file, compiles it to PDF, and lets you open the result.

### Agent tool calls

Agents with the extraction tools can invoke `extract_tikz_figures` to perform the same discovery and optional compilation steps programmatically:

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

## <wa-icon library="texra" name="settings-gear"></wa-icon> Customizing TikZ processing

Several settings tune how TeXRA handles TikZ. They have no control in Settings, so set the keys below as flat `texra.*` keys in `<project>/.texra/config.json` (project) or `~/.texra/v1/global-storage/config.json` (user-wide). All three hosts read those files; TeXRA does not read VS Code settings.

### TikZ template

The standalone document structure TeXRA uses for each extracted figure:

```json
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

Customize this template to include additional packages or settings your figures need.

### TikZ input directory

If your TikZ figures depend on custom styles or macros, specify an input directory:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs"
```

The directory is added to the LaTeX search path when compiling figures.

### Including workspace in `TEXINPUTS`

By default TeXRA adds your workspace root to `TEXINPUTS`:

```json
"texra.latex.includeWorkspaceInTexinputs": true
```

This helps LaTeX locate packages and styles stored elsewhere in the project.

## <wa-icon library="texra" name="library"></wa-icon> Figure libraries

Agents with tools can reuse existing figures as references when creating new ones.

### Using reference figures

1. Add previous TikZ figures to the **Context** section (<wa-icon library="texra" name="book"></wa-icon>).
2. Mention them explicitly in your instructions.
3. Ask the agent to adopt similar styles or approaches.

**Example instruction:**

```
Create a TikZ diagram of a neural network architecture similar to the one in
the reference file, but add an attention mechanism between the encoder and decoder.
Maintain the same visual style and color scheme as the reference figure.
```

## <wa-icon library="texra" name="debug"></wa-icon> Troubleshooting TikZ issues

When a figure does not build, find the matching failure mode and work through its checks.

<TikzTroubleshootCards />

<p class="hero-caption">Three failure modes, each with its remedies: find your symptom, fix it, recompile.</p>

## <wa-icon library="texra" name="lightbulb"></wa-icon> Tips

- **Point at a reference figure**: Attach an existing `.tex` figure in **Context** (<wa-icon library="texra" name="book"></wa-icon>) when you want a new diagram to match its node styles, arrow tips, and color palette.
- **Cache slow figures**: For documents with many complex `tikzpicture` environments, enable PGF's `external` library so unchanged figures are not recompiled on every build.

## Next steps

- [LaTeX Diff](./latex-diff.md): compare document versions including figures
- [LaTeX Tools](./latex-tools.md): the full set of LaTeX tools TeXRA plugs into
- [Best practices](./best-practices.md): general tips for working with TeXRA
