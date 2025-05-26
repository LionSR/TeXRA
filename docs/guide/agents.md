# Built-in Agent Reference

TeXRA provides a variety of built-in AI agents designed to assist with different aspects of academic research. Each agent is optimized for specific tasks. You can select these agents from the dropdown menu in the TeXRA UI.

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Correction & Polishing Agents

### `correct`

The `correct` agent focuses on fixing errors without changing the style or content of your document.

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

### `polish_cover`

The `polish_cover` agent focuses specifically on improving the style, clarity, and impact of cover letters.

**Purpose:** Enhance the quality and persuasiveness of academic cover letters.

**Best for:**

- Refining draft cover letters for job applications or submissions
- Ensuring a professional and compelling tone

**Example instruction:**

```
Polish this cover letter to improve its clarity, flow, and professional tone. Ensure it strongly highlights my qualifications for the [Job Title/Submission Venue]. Make the language concise and impactful.
```

## Content Generation & Transformation Agents

### `derive`

The `derive` agent focuses on deriving mathematical equations or logical steps.

**Purpose:** Assist with mathematical derivations and logical reasoning.

**Best for:**

- Filling in intermediate steps in a derivation
- Checking the logical flow of an argument
- Deriving equations based on stated principles

**Example instruction:**

```
Starting from Equation (1) and assuming [state assumptions], derive the expression for [target variable]. Show the key intermediate steps clearly.
```

### `paper2note`

The `paper2note` agent transforms research papers into comprehensive lecture notes.

**Purpose:** Convert academic papers to educational materials.

**Best for:**

- Creating teaching materials from research papers
- Converting dense research into student-friendly content
- Developing study guides for complex topics

**Example instruction:**

```
Transform this research paper into lecture notes suitable for a graduate-level course.
Add explanatory text for complex concepts, include discussion questions, and highlight
key takeaways. Create sections for Introduction, Background, Methods, Results, and Discussion.
```

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

### `paper2cover`

The `paper2cover` agent generates a draft cover letter based on the content of a research paper.

**Purpose:** Quickly create a starting point for a submission cover letter.

**Best for:**

- Drafting cover letters for journal submissions
- Summarizing a paper's contribution for introductory purposes

**Example instruction:**

```
Generate a draft cover letter for submitting this paper to [Journal Name]. Highlight the main contributions, significance, and suitability for the journal based on the paper's content.
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

The `transcribe_audio` agent converts audio files into text transcripts.

**Purpose:** Create text versions of audio recordings.

**Best for:**

- Transcribing interviews or lectures
- Converting meeting recordings to text
- Creating subtitles or notes from audio

**Example instruction:**

```
Transcribe the provided audio file [interview.mp3]. Provide the output as a plain text file with speaker labels if possible.
```

## Specialized Agents

### `solve_qi`

The `solve_qi` agent attempts to solve quantitative interview (QI) style questions.

**Purpose:** Assist with solving quantitative problems, often found in technical interviews.

**Best for:**

- Practicing quantitative interview questions
- Getting step-by-step solutions for math or logic puzzles
- Understanding problem-solving approaches for quantitative tasks

**Example instruction:**

```
Solve the following quantitative interview question, showing your reasoning and steps clearly: [Insert Question Here]
```

### `merge`

The `merge` agent intelligently combines changes from an edited document back into a base document.

**Purpose:** Integrate edits from different versions or sources while resolving conflicts.

**Best for:**

- Applying AI-suggested edits from a `_r0_` or `_r1_` file
- Incorporating reviewer suggestions from a separate file
- Combining different drafts or collaborator edits

**Example instruction:**

```
Merge changes from the edited file into the original document (base file). Prioritize substantive
improvements in clarity while maintaining the original's technical precision.
Preserve mathematical notation and citations from the original.
```

## Next Steps

Now that you understand the default built-in agents, you might want to learn more:

- [Agent Architecture & Execution Flow](./agent-architecture.md) - Understand how agents work internally.
- [Custom Agents](./custom-agents.md) - Learn how to create your own specialized agents.
- [Models](/guide/models) - Learn about the different AI models and their capabilities.
