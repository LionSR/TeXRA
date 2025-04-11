# Built-in Agent Reference

TeXRA provides a variety of built-in AI agents, each like a specialized research assistant ready for a specific task. Choosing the right one from the dropdown menu in the TeXRA UI is the first step to AI-powered productivity (or at least, less painful editing).

::: warning Important Note
The underlying prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions as we continue to optimize them. If you require precise, unchanging behavior or wish to heavily customize the process, consider creating a [Custom Agent](./custom-agents.md) based on these examples.
:::

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Correction & Polishing Agents

### `correct`

The `correct` agent focuses on fixing errors without changing the style or content of your document (think of it as a meticulous, slightly obsessive proofreader).

**Purpose:** Fix typos, grammatical errors, and LaTeX syntax issues.

**Best for:**

- Final proofreading before submission
- Fixing errors in collaborative documents
- Ensuring consistent formatting and notation

**Example instruction:**

```
Fix grammatical errors, typos, and LaTeX syntax issues throughout the document.
Ensure consistent notation for mathematical symbols and equations.
Don't change the technical content or writing style.
```

### `polish`

The `polish` agent enhances the writing style and clarity of your document while preserving technical content.

**Purpose:** Improve readability, flow, and overall writing quality.

**Best for:**

- Enhancing draft manuscripts
- Making technical content more accessible
- Improving the flow between sections

**Example instruction:**

```
Improve the clarity and readability of this document. Make the language more concise
and enhance the flow between paragraphs. Maintain all technical content and equations.
Focus especially on the introduction and discussion sections.
```

## Content Generation & Transformation Agents

### `paper2slide`

The `paper2slide` agent converts research papers into LaTeX beamer presentations.

**Purpose:** Create presentation slides from academic content.

**Best for:**

- Preparing conference presentations
- Converting papers for teaching purposes
- Creating seminar materials

**Example instruction:**

```
Convert this paper into a beamer presentation with approximately 15-20 slides.
Include a title slide, outline, introduction, methodology, results, and conclusion.
Use bullet points for clarity and add slide titles. Include the key figures and tables.
```

### `paper2poster`

The `paper2poster` agent transforms papers into academic conference posters.

**Purpose:** Create well-structured academic posters.

**Best for:**

- Conference poster preparation
- Visual research summaries
- Academic showcases

**Example instruction:**

```
Convert this paper into an academic poster using the baposter template.
Include sections for Introduction, Methodology, Results, and Conclusions.
Highlight key figures and tables. Make it visually appealing with appropriate columns.
```

## Figure & Media Agents

### `draw`

The `draw` agent creates or enhances TikZ figures based on textual descriptions or existing figures.

**Purpose:** Generate visual representations of concepts, systems, or data.

**Best for:**

- Creating diagrams, flowcharts, or schematics from descriptions
- Improving existing TikZ figures
- Converting descriptions into LaTeX visualizations

**Example instruction:**

```
Create a TikZ figure illustrating a neural network with an input layer (3 nodes),
two hidden layers (5 nodes each), and an output layer (2 nodes).
Use appropriate colors and add labels for each layer.
```

### `ocr`

The `ocr` agent performs Optical Character Recognition (OCR) on image or PDF files.

**Purpose:** Extract text content from images or non-searchable PDFs.

**Best for:**

- Extracting text from scanned documents or figures
- Making image-based text searchable and editable
- Processing figures containing text for analysis

**Example instruction:**

```
Perform OCR on the provided image file [figure.png] and extract all text content. Format the output as plain text.
```

### `transcribe_audio`

The `transcribe_audio` agent converts audio files (like lectures, podcasts, or personal notes) into text transcripts. (Note: Requires native audio support, see [Working with Figures](./working-with-figures.md)).

**Purpose:** Create searchable text versions of spoken audio content.

**Best for:**

- Transcribing recorded lectures or talks
- Converting podcast episodes to text
- Transcribing personal voice memos or notes

**Example instruction:**

```
Transcribe the provided lecture audio file [lecture.mp3]. Provide the output as plain text, identifying different speakers if possible (e.g., Lecturer, Questioner 1).
```

## Next Steps

Now that you've met the built-in crew, you might want to dive deeper:

- [Agent Architecture & Execution Flow](./agent-architecture.md) - Understand how agents work internally.
- [Custom Agents](./custom-agents.md) - Learn how to create your own specialized agents.
- [Models](./models.md) - Learn about the different AI models and their capabilities.
