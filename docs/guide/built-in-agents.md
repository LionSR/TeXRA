<script setup>
import DropdownMenu from '../.vitepress/components/DropdownMenu.vue';
</script>

# Built-in Agent Reference

TeXRA ships with built-in agents for common research tasks—polishing prose, fixing errors, creating figures, converting formats, and more. Pick one from the dropdown in the TeXRA UI and you're ready to go.

<DropdownMenu
  label="Agent"
  value="polish"
  valueIcon="sparkle"
  maxWidth="480px"
  columns="2"
  :groups="[
    {
      label: 'Tool-use',
      items: [
        { name: 'chat', icon: 'comment' },
        { name: 'research', icon: 'robot' },
        { name: 'numerics', icon: 'pulse' },
        { name: 'review', icon: 'circle-check' },
        { name: 'lean', icon: 'check' },
        { name: 'presenter', icon: 'device-camera-video' },
        { name: 'latexFixer', icon: 'screwdriver-wrench' },
        { name: 'latexDiff', icon: 'diff' },
        { name: 'setup', icon: 'settings-gear' },
        { name: 'creator', icon: 'wand' },
      ],
    },
    {
      label: 'Workflow',
      items: [
        { name: 'correct', icon: 'check' },
        { name: 'polish', icon: 'sparkle', active: true },
        { name: 'paper2slide', icon: 'file-pdf' },
        { name: 'paper2poster', icon: 'file-pdf' },
        { name: 'ocr', icon: 'file-code' },
        { name: 'transcribe_audio', icon: 'mic' },
        { name: 'merge', icon: 'merge' },
      ],
    },
  ]"
/>

<p class="hero-caption">The agent picker, split by the two agent classes — <code>tool-use</code> (left) and <code>workflow</code> (right) — with the selected agent (<code>polish</code>) highlighted.</p>

## Quick Reference

| Agent              | Type     | Purpose                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `research`         | Tool-use | Analytical derivations and numerical programming with Wolfram             |
| `review`           | Tool-use | Mathematical and manuscript verification                                  |
| `numerics`         | Tool-use | Design, run, and validate computational experiments                       |
| `lean`             | Tool-use | Lean 4 proof development                                                  |
| `presenter`        | Tool-use | Interactive presentation and poster builder                               |
| `latexFixer`       | Tool-use | Diagnose and fix LaTeX compilation errors, warnings, and bad boxes        |
| `latexDiff`        | Tool-use | Generate a visual latexdiff PDF between two LaTeX versions                |
| `creator`          | Tool-use | Design, write, and test new TeXRA agents                                  |
| `setup`            | Tool-use | Setup wizard: diagnose environment, install dependencies, configure       |
| `chat`             | Tool-use | General assistance, file editing (opt-in; not in any default team preset) |
| `correct`          | Workflow | Fix errors without style changes                                          |
| `polish`           | Workflow | Improve writing quality                                                   |
| `paper2slide`      | Workflow | Convert papers to beamer slides                                           |
| `paper2poster`     | Workflow | Create academic posters                                                   |
| `ocr`              | Workflow | Extract text from images/PDFs                                             |
| `transcribe_audio` | Workflow | Transcribe audio to text                                                  |
| `merge`            | Workflow | Intelligently merge document versions                                     |

::: warning Important Note
The underlying prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions as we continue to optimize them. If you require precise, unchanging behavior or wish to heavily customize the process, consider creating a [Custom Agent](./custom-agents.md) based on these examples.
:::

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Conversational Agents

### `chat`

::: tip Opt-in
`chat` is no longer included in any of the built-in team presets (Lean Project, Physicist, Mathematician). Enable it from the **Agents** tab if you want to use it.
:::

A general research companion. It can read your project, edit files, run shell commands, and search through your workspace—all in a back-and-forth conversation.

> **User story:** You just got reviewer comments back. Instead of manually hunting through a 40-page paper, you open `chat` and paste the reviewer's feedback: "Address comment 3 about missing error bars in Table 2—add them and update the caption." The agent reads your files, makes the edits, and shows you a diff to approve.

**Best for:** General research assistance, code/LaTeX editing, running compilations

**Example instruction:**

```
Review my introduction in paper.tex and suggest improvements for clarity.
Then update the file with your changes.
```

## Research & Discovery Agents

### `research`

A hands-on research agent that can edit your files **and** verify mathematics computationally. When you need to check a derivation or run a symbolic calculation alongside your writing, this is the one.

**Best for:** Mathematical derivations, computational verification, multi-step research

**Example instruction:**

```
Derive the variational equations for the Lagrangian in equations.tex.
Verify each step computationally and update the file with results.
```

### `numerics`

A numerical-experiments agent that designs, implements, and validates computational experiments following the scientific method. Use it when a claim needs to be backed by code and reproducible results rather than symbolic derivation alone.

**Best for:** Convergence studies, benchmarking, simulation-backed results, sanity-checking numerics

**Example instruction:**

```
Implement and run a convergence study for the solver in solver.py.
Sweep the step size, plot the error, and report the observed order of accuracy.
```

## Verification Agents

### `review`

A meticulous scientific auditor that systematically verifies your research manuscript. It checks mathematical correctness, derivation soundness, notation consistency, code-manuscript agreement, and goal achievement — using Wolfram for computational verification.

**Best for:** Pre-submission audits, mathematical verification, notation consistency checks

**Example instruction:**

```
Audit this manuscript: verify every derivation step-by-step, check notation
consistency across all sections, and confirm that every stated goal in the
abstract is actually delivered in the paper.
```

## Formal Methods Agents

### `lean`

Helps you write and debug Lean 4 proofs. It reads compiler diagnostics, inspects proof state, and iterates until the proof compiles.

**Best for:** Formalizing proofs, Lean 4 development, Mathlib projects

**Example instruction:**

```
Formalize the proof of the theorem in Proofs/GroupTheory.lean. Start with an
informal outline, then produce Lean code and iterate until it compiles.
```

## Presentation & Simplification Agents

### `presenter`

Builds conference-ready Beamer presentations, posters, and visual materials from your project. Point it at your paper and it reads through your work, plans the slide structure, generates figures, and compiles the result—checking every slide visually before handing it back to you.

**Best for:** Conference talks, poster sessions, seminar presentations, lightning talks

**Example instruction:**

```
Create a 15-slide Beamer presentation from this project. Cover motivation, the core
algorithm, key results, and future work. Use the metropolis theme and include TikZ
diagrams for the architecture.
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

The `polish` agent improves the writing quality of your document while preserving essential technical content and meaning.

> **User story:** Your draft is technically solid but reads like it was written at 3 AM (because it was). Select `polish`, tell it "Improve clarity for a CVPR audience—keep all equations and citations intact," and in a couple of minutes you'll have a version that reads like it went through a professional copyedit. Review the colour-coded diff to accept or reject each change.

This agent is ideal for refining drafts that are technically sound but need language improvements before submission.

#### Example Output

Try running `polish` on the [sample document](/examples/draft.pdf) to see a colour-coded diff showing exactly what changed. The agent produces versioned output files with latexdiff highlighting additions in blue and deletions in red.

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

::: tip Creating figures
There is no longer a dedicated `draw` agent. To generate or enhance TikZ figures, use a tool-use agent (`research` or `presenter`) and describe the figure — the agent writes compilable TikZ, compiles it, and visually verifies the result. See [Working with Figures](./working-with-figures.md) and [TikZ Figures](./tikz-figures.md).
:::

## LaTeX & Build Agents

### `latexFixer`

Diagnoses and fixes LaTeX compilation errors, warnings, and bad boxes. Point it at a project that won't compile (or compiles with ugly overfull boxes) and it reads the build log, locates the cause, and iterates until the document is clean.

**Best for:** Resolving build failures, clearing warnings, fixing overfull/underfull boxes

**Example instruction:**

```
This project fails to compile. Read the latexmk log, fix the underlying errors,
and rebuild until it produces a clean PDF.
```

### `latexDiff`

Generates a visual diff PDF between two LaTeX versions using `latexdiff`, so you can see exactly what changed between drafts.

**Best for:** Reviewing changes between versions, preparing "changes marked" PDFs for co-authors or referees

**Example instruction:**

```
Produce a latexdiff PDF comparing the submitted version (v1/main.tex) with the
current revision (main.tex), highlighting additions and deletions.
```

## Figure & Media Agents

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

## Merge Agent

### `merge`

Takes an AI-edited document and merges the improvements back into your original, keeping the best of both. It understands context, so it won't blindly overwrite your careful phrasing with generic rewrites.

**Best for:** Applying AI-suggested edits from output files, incorporating reviewer suggestions, combining different drafts

**Example instruction:**

```
Merge changes from the edited file into the original document. Prioritize substantive
improvements in clarity while maintaining the original's technical precision.
Preserve mathematical notation and citations from the original.
```

See [Intelligent Merge](./intelligent-merge.md) for details on the merge workflow.

## Setup & Meta Agents

### `setup`

A setup wizard that diagnoses your environment, installs missing dependencies, configures TeXRA, and orchestrates your first task. If you are new to TeXRA or moving to a new machine, start here.

**Best for:** First-time setup, diagnosing missing dependencies, getting unblocked

**Example instruction:**

```
Check whether my environment has everything TeXRA needs, install anything missing,
and help me run my first agent on this project.
```

### `creator`

Designs, writes, and tests new TeXRA agents through conversation. Describe the behavior you want and `creator` drafts the agent YAML, then helps you refine and validate it.

**Best for:** Building [custom agents](./custom-agents.md) without hand-writing YAML from scratch

**Example instruction:**

```
Help me build a custom agent that rewrites abstracts to a 150-word limit while
preserving every numerical result. Draft the YAML and walk me through testing it.
```

## Remote Agents

The following agents are available as [remote agents](./remote-agents.md) through the Research Access Program. Sign in to TeXRA to access them.

### `search`

Finds papers and web content for you. Give it a topic and it comes back with relevant preprints, published articles, and web resources. Read-only — it won't touch your files.

**Best for:** Literature reviews, finding citations, fact-checking

**Example instruction:**

```
Find recent papers on transformer architectures for scientific document understanding.
Focus on papers from 2023-2024 that address mathematical equation handling.
```

### `discuss`

A brainstorming partner that can pull in relevant literature as you talk. Useful for thinking through research directions, poking holes in methodology, or connecting ideas across papers. Read-only.

**Best for:** Brainstorming, methodology critique, research direction guidance

**Example instruction:**

```
I'm considering attention mechanisms for my theorem prover. What are the
tradeoffs compared to tree-based approaches? What does the literature say?
```

### `simplifier`

Cuts through complexity in your code and writing. Whether it's duplicated logic across files, overly-abstract wrappers, or LLM-generated filler prose, `simplifier` cleans things up while preserving correctness.

**Best for:** Refactoring research code, tightening manuscript prose, cleaning up verbose AI-generated text

**Example instruction:**

```
Simplify the numerical solver in solver.py. Look for duplicated code, inline any
single-use helper functions, and remove dead code. Run existing tests after each change.
```

::: tip
Additional remote agents may be available depending on your access level. Check **TeXRA: View Profile** for the full list.
:::

## Next Steps

- [Agent Architecture](./agent-architecture.md) - How agents work internally
- [Research Tools](./research-tools) - Literature discovery and web tools
- [Custom Agents](./custom-agents.md) - Create your own agents
- [Models](./models.md) - AI model selection
