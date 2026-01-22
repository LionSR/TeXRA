# Built-in Agent Reference

TeXRA provides built-in AI agents, each specialized for specific research tasks. Choose from the dropdown menu in the TeXRA UI.

## Quick Reference

| Agent              | Type     | Purpose                                 |
| ------------------ | -------- | --------------------------------------- |
| `chat`             | Tool-use | General assistance, file editing        |
| `ask`              | Tool-use | Read-only questions and exploration     |
| `search`           | Tool-use | Literature discovery, web search        |
| `research`         | Tool-use | Computational verification with Wolfram |
| `discuss`          | Tool-use | Academic brainstorming with literature  |
| `lean`             | Tool-use | Lean 4 proof development                |
| `correct`          | Workflow | Fix errors without style changes        |
| `polish`           | Workflow | Improve writing quality                 |
| `paper2slide`      | Workflow | Convert papers to beamer slides         |
| `paper2poster`     | Workflow | Create academic posters                 |
| `draw`             | Workflow | Create/enhance TikZ figures             |
| `ocr`              | Workflow | Extract text from images/PDFs           |
| `transcribe_audio` | Workflow | Transcribe audio to text                |

::: warning Important Note
The underlying prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions as we continue to optimize them. If you require precise, unchanging behavior or wish to heavily customize the process, consider creating a [Custom Agent](./custom-agents.md) based on these examples.
:::

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Conversational Agents

### `chat`

A general-purpose research assistant that can read, write, and edit files in your workspace. It acts as a friendly scientist focused on careful reasoning.

**Capabilities:**

- Read and analyze your documents
- Edit files with your approval (via VS Code diff view)
- Run shell commands for compilation or other tasks
- Search through your project files

**Best for:** General research assistance, code/LaTeX editing, running compilations

**Example instruction:**

```
Review my introduction in paper.tex and suggest improvements for clarity.
Then update the file with your changes.
```

### `ask`

A read-only assistant for exploring your workspace without risk of modifications.

**Capabilities:**

- Read and analyze documents
- Search through project files
- Answer questions about your codebase

**Best for:** Quick questions, understanding existing code, safe exploration

**Example instruction:**

```
What packages does this LaTeX project use? Summarize the document structure.
```

## Research & Discovery Agents

### `search`

Specializes in finding academic literature and web content. Read-only - cannot modify your files.

**Capabilities:**

- Search arXiv for preprints and papers
- Look up publications via Crossref/DOI
- Fetch and summarize web pages
- Cross-reference multiple sources

**Best for:** Literature reviews, finding citations, fact-checking

**Example instruction:**

```
Find recent papers on transformer architectures for scientific document understanding.
Focus on papers from 2023-2024 that address mathematical equation handling.
```

### `research`

Combines file editing with computational verification using Wolfram Language for symbolic mathematics.

**Capabilities:**

- Perform symbolic and numerical calculations
- Verify mathematical derivations step-by-step
- Edit files with computational results
- Track progress on complex tasks

**Best for:** Mathematical derivations, computational verification, multi-step research

**Example instruction:**

```
Derive the variational equations for the Lagrangian in equations.tex.
Verify each step computationally and update the file with results.
```

### `discuss`

An academic discussion partner for brainstorming and exploring research directions. Read-only with literature access.

**Capabilities:**

- Engage in substantive intellectual discourse
- Find and synthesize relevant literature
- Offer counterarguments and alternative perspectives
- Connect ideas across papers

**Best for:** Brainstorming, methodology critique, research direction guidance

**Example instruction:**

```
I'm considering attention mechanisms for my theorem prover. What are the
tradeoffs compared to tree-based approaches? What does the literature say?
```

## Formal Methods Agents

### `lean`

Interactive Lean 4 proof assistant with VS Code integration.

**Capabilities:**

- Get real-time diagnostics and error feedback
- Inspect proof state and types at any position
- Search Mathlib for relevant lemmas
- Build and verify proofs

**Best for:** Formalizing proofs, Lean 4 development, Mathlib projects

**Example instruction:**

```
Formalize the proof of the theorem in Proofs/GroupTheory.lean. Start with an
informal outline, then produce Lean code and iterate until it compiles.
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

## Next Steps

- [Agent Architecture](./agent-architecture.md) - How agents work internally
- [Research Tools](./research-tools) - Literature discovery and web tools
- [Custom Agents](./custom-agents.md) - Create your own agents
- [Models](./models.md) - AI model selection
