# Built-in Agent Reference

TeXRA provides a variety of built-in AI agents, each like a specialized research assistant ready for a specific task. Choosing the right one from the dropdown menu in the TeXRA UI is the first step to AI-powered productivity (or at least, less painful editing).

::: warning Important Note
The underlying prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions as we continue to optimize them. If you require precise, unchanging behavior or wish to heavily customize the process, consider creating a [Custom Agent](./custom-agents.md) based on these examples.
:::

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Conversational Agents

### `chat`

The `chat` agent acts as a friendly scientist focused on careful reasoning during conversation.
It can execute `bash` commands and manipulate files using the `read_file`,
`write_file`, and `edit_file` tools.
Whenever an agent proposes a workspace edit, TeXRA opens VS Code's native diff
view so you can review and approve (or reject with feedback) before the change
touches disk.

You can disable this approval checkpoint through the
`texra.toolUse.requireEditApproval` setting if you prefer edits to apply
immediately.
Use the `glob`, `grep`, and `ls` tools to explore the workspace without leaving the sandbox.
When derivations are required, it presents steps inside `\begin{aligned} ... \end{aligned}` blocks
to keep mathematical discussions accurate.

> **Heads up:** `read_file` returns at most the first 2,000 lines of a file and prefixes each line with a `cat -n` style line number so tool outputs stay readable.

### `ask`

The `ask` agent provides a read-only workspace companion for exploratory
questions.
It is limited to the `read_file`, `glob`, `grep`, and `ls` tools so it can
inspect project files without modifying them or running arbitrary shell
commands.
Pick this agent when you want to look up details in the repository without the
risk of accidental edits.

## Research & Discovery Agents

### `search`

The `search` agent specializes in web search and academic literature discovery. It provides read-only research capabilities with access to arXiv, Crossref, and web search tools.

**Tools available:** `web_search`, `web_fetch`, `arxiv_search`, `arxiv_metadata`, `crossref_search`, `crossref_doi`, `read_file`, `glob`, `grep`, `ls`, `extract_figures`, `extract_bib_entries`, `extract_tikz_figures`

**Best for:**

- Literature reviews and finding relevant papers
- Verifying facts and finding citations
- Exploring a research topic across multiple sources
- Cross-referencing academic databases

**Example instruction:**

```
Find recent papers on transformer architectures for scientific document understanding.
Focus on papers from 2023-2024 that specifically address mathematical equation handling.
```

### `research`

The `research` agent combines analytical derivations with computational verification using Wolfram Language. Unlike `search`, this agent can edit files and execute complex computations.

**Tools available:** `wolfram`, `todo_write`, `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`, `ls`, `extract_figures`, `extract_bib_entries`, `extract_tikz_figures`, `texcount`

**Best for:**

- Symbolic mathematics and analytical derivations
- Numerical verification of calculations
- Step-by-step mathematical proofs with verification
- Complex multi-step research workflows

**Example instruction:**

```
Derive the variational equations for the Lagrangian in equations.tex.
Verify each step using Wolfram Language and convert the final results to LaTeX.
```

### `discuss`

The `discuss` agent serves as an academic discussion partner for exploring ideas, critiquing approaches, and brainstorming research directions. It has read-only file access plus literature tools.

**Tools available:** `read_file`, `glob`, `grep`, `ls`, `arxiv_search`, `arxiv_metadata`, `download_arxiv_source`, `crossref_search`, `crossref_doi`, `extract_bib_entries`

**Best for:**

- Brainstorming research directions
- Critical discussion of methodologies
- Connecting ideas across different papers
- Getting feedback on research approaches

**Example instruction:**

```
I'm considering using attention mechanisms for my theorem prover. What are the
tradeoffs compared to tree-based approaches? What does the literature say?
```

## Formal Methods Agents

### `lean`

Lean 4 proof assistant with VS Code extension integration and CLI fallback. Uses
dedicated tools (`lean_diagnostics`, `lean_inspect`, `lean_project`, `lean_loogle`)
for verification, with bash `lake`/`lean` commands as fallback when needed.

**Best for:**

- Interactive proof development with real-time feedback
- Inspecting proof state and types at specific positions
- Projects using Mathlib (with `lean_loogle` search)
- Building and verifying via CLI when extension tools are insufficient

**Example instruction:**

```
Formalize the proof of the theorem in `Proofs/GroupTheory.lean`. Start with an
informal outline, then produce Lean code and iterate until it passes.
```

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

The `polish` agent improves the writing quality of your document while preserving essential technical content and meaning. It focuses on:

- Enhancing clarity and readability
- Improving sentence structure and paragraph flow
- Fixing grammatical issues and typos
- Standardizing formatting and style

This agent is ideal for refining drafts that are technically sound but need language improvements or polishing before submission.

#### Example Output

<div class="agent-pdf-viewer">
  <iframe src="/examples/draft_polish_r1_gemini25p_diff.pdf" title="Polish Agent Example" class="agent-pdf-frame"></iframe>
  <a href="/examples/draft_polish_r1_gemini25p_diff.pdf" target="_blank" class="agent-pdf-link">View example</a>
</div>

<style>
.agent-pdf-viewer {
  position: relative;
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  margin: 1rem 0;
}
.agent-pdf-frame {
  width: 100%;
  height: 350px;
  border: none;
}
.agent-pdf-link {
  position: absolute;
  top: 10px;
  right: 10px;
  color: white;
  padding: 5px 10px;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.85rem;
}
.agent-pdf-link:hover {
  background: var(--vp-c-brand);
}
</style>

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

## Utility Agents

### `xml_validator`

The `xml_validator` agent detects and fixes XML syntax errors using the `str_replace_editor` tool. It iterates until the XML file is valid.

**Tools available:** `str_replace_editor`

**Best for:**

- Fixing malformed XML configuration files
- Repairing XML parsing errors
- Validating XML syntax before processing

### `tex_linter_fix`

The `tex_linter_fix` agent automatically resolves LaTeX linter warnings and errors. It can analyze figure references, bibliography entries, and TikZ code to understand context.

**Tools available:** `str_replace_editor`, `diagnostics`, `extract_figures`, `extract_bib_entries`, `extract_tikz_figures`

**Best for:**

- Fixing chktex and other linter warnings
- Cleaning up LaTeX style issues
- Resolving missing reference warnings

## Next Steps

Now that you've met the built-in crew, you may want to learn more:

- [Agent Architecture & Execution Flow](./agent-architecture.md) - Understand how agents work internally.
- [Tool-Use Agents Reference](/reference/tool-use-agents) - Deep dive into tool-use agent architecture.
- [Tools Reference](/reference/tools) - Complete reference for all available tools.
- [Research Tools Guide](./research-tools) - Using research and literature discovery tools.
- [Custom Agents](./custom-agents.md) - Learn how to create your own specialized agents.
- [Models](./models.md) - Learn about the different AI models and their capabilities.
