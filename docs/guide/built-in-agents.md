<script setup>
import DropdownMenu from '../.vitepress/components/DropdownMenu.vue';
import AgentModeShapes from '../.vitepress/components/AgentModeShapes.vue';
import CliAgentsListHero from '../.vitepress/components/CliAgentsListHero.vue';
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
        { name: 'assistant', icon: 'comment' },
        { name: 'prover', icon: 'lightbulb' },
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

The same catalog is enumerable from any terminal:

<CliAgentsListHero />

<p class="hero-caption">One <code>category &nbsp;name&nbsp; description</code> row per agent — tab-separated, stable for scripts; <code>--category workflow</code> filters, <code>--all</code> includes hidden agents.</p>

## Quick Reference

Every built-in agent is one of two execution shapes — a tool-use loop or a
workflow pipeline:

<AgentCatalog />

The two shapes behave differently once they run:

<AgentModeShapes />

<p class="hero-caption">Tool-use agents loop — converse and call tools until done; workflow agents run a fixed input → edit → diff pipeline and hand back a versioned diff.</p>

::: warning Important Note
The underlying prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions as we continue to optimize them. If you require precise, unchanging behavior or wish to heavily customize the process, consider creating a [Custom Agent](./custom-agents.md) based on these examples.
:::

For details on the underlying structure and execution flow common to all agents, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.

## Conversational Agents

### `assistant`

::: tip Opt-in
`assistant` is not included in any of the [built-in teams](#built-in-teams).
Enable it from the **Agents** tab if you want to use it.
:::

A general-purpose scientific assistant with the broadest toolset of any built-in agent. It can read your project, edit files, run shell commands, search the literature (arXiv, Crossref, web), manage Zotero references, run Wolfram computations, work on Lean 4 proofs, and delegate to specialist agents or external AI coding agents (Codex, Claude Code)—all in a back-and-forth conversation.

> **User story:** You just got reviewer comments back. Instead of manually hunting through a 40-page paper, you open `assistant` and paste the reviewer's feedback: "Address comment 3 about missing error bars in Table 2—add them and update the caption." The agent reads your files, makes the edits, and shows you a diff to approve.

**Best for:** General research assistance, literature search, code/LaTeX editing, computations, running compilations

**Example instruction:**

```
Review my introduction in paper.tex and suggest improvements for clarity.
Then update the file with your changes.
```

## Problem-Solving Agents

### `prover`

A research mathematician for open and research-level problems — Erdős problems, conjectures posed at the end of papers, or questions from your own work. It checks the problem's current status in the literature first, computes small cases and hunts for counterexamples, lays out candidate lines of attack, and develops proofs lemma-by-lemma with adversarial self-verification. It reports honestly: SOLVED, DISPROVED, PARTIAL, or OPEN with the exact obstruction — partial progress (special cases, reductions, improved bounds) is written up as such, never oversold.

**Best for:** Attacking open problems, counterexample searches, turning conjectures into verified partial results

**Example instruction:**

```
Attack the open problem stated in problem.tex. Check its current status on
erdosproblems.com and arXiv first, compute small cases, then either prove it,
disprove it, or report the strongest partial result you can rigorously verify.
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

The `ocr` agent converts handwritten mathematical content from images into LaTeX.

**Purpose:** Turn handwritten equations and notes into LaTeX code that matches your document's notation and style.

**Best for:**

- Converting handwritten derivations or lecture-board photos into LaTeX
- Digitizing handwritten mathematical notes across multiple images
- Keeping converted notation consistent with the existing document

**Example instruction:**

```
Convert the handwritten derivation in [notes.png] into LaTeX, matching the notation used in the attached document.
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

## Software Engineering Agents

These agents make up the [Software Engineer team](#built-in-teams) for the code
that accompanies a project — simulations, numerics, data pipelines, scripts,
and small libraries. The Computer Scientist team also includes `coder` and
`testEngineer` for implementing and pinning down experiment code.

### `engineer`

The team lead. Turns a coding goal into focused tasks, delegates each to the right specialist, reviews their work, and keeps the codebase coherent.

**Best for:** Multi-step coding goals you want planned, delegated, and verified end to end

**Example instruction:**

```
Speed up scripts/simulate.py without changing its results. Profile it first,
then optimize the hot loops, and make sure the regression tests still pass.
```

### `coder`

Implements features, makes surgical edits, and fixes bugs, then verifies the change builds and passes the project's checks.

**Best for:** Implementation, focused edits, bug fixes

### `codeReviewer`

Reviews a diff or file for correctness, clarity, security, and convention fit, and reports prioritized findings. Read-only — it does not edit.

**Best for:** Pre-merge review, auditing generated code

### `testEngineer`

Writes and maintains tests — pins down existing behaviour, covers new code and edge cases, and keeps the suite fast and reliable.

**Best for:** Adding coverage, characterization tests, keeping suites healthy

### `codeSimplifier`

Refactors working code for clarity, reuse, and efficiency without changing its behaviour, then confirms the tests still pass. Quality only — it does not hunt for bugs.

**Best for:** Behaviour-preserving cleanup of research code

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

The following agents are available as [remote agents](./remote-agents.md) through the Researcher Access Program. Sign in to TeXRA to access them.

### `search`

Finds papers and web content for you. Give it a topic and it comes back with relevant preprints, published articles, and web resources. Read-only — it won't touch your files.

**Best for:** Literature reviews, finding citations, fact-checking

**Example instruction:**

```
Find recent papers on transformer architectures for scientific document understanding.
Focus on papers from 2023-2024 that address mathematical equation handling.
```

### `simplifier`

Cuts through complexity in your code and writing. Whether it's duplicated logic across files, overly-abstract wrappers, or LLM-generated filler prose, `simplifier` cleans things up while preserving correctness.

**Best for:** Refactoring research code, tightening manuscript prose, cleaning up verbose AI-generated text

**Example instruction:**

```
Simplify the numerical solver in solver.py. Look for duplicated code, inline any
single-use helper functions, and remove dead code. Run existing tests after each change.
```

### `orchestrator`

Coordinates multi-agent work on LaTeX research projects. It reads project context, turns broad goals into focused tasks, routes each task to the right specialist, tracks results, reviews generated files, and keeps follow-up work organized. The lead agent for the Physicist, Mathematician, and Computer Scientist [teams](#built-in-teams).

**Best for:** Multi-step research goals that span several specialists

### `progressCheck`

An end-of-session reviewer. It looks at what was just done, the project's standing goal, and the git/PR state to decide whether the orchestrator is actually finished or whether meaningful, low-risk progress is still on the table. Read-only — it advises, but does not edit or delegate. Bundled with every [team](#built-in-teams) except Software Engineer.

**Best for:** Auditing what a team run actually delivered versus the goal

::: tip
Additional remote agents may be available depending on your access level. In the VS Code extension, run **TeXRA: Show Agents** from the Command Palette for the full list. See [Remote Agents](./remote-agents.md) to sign in and sync them.
:::

## Built-in Teams

Teams are predefined collections of agents for a discipline. Pick one from the
**Teams** tab in the Dashboard, or run one from the CLI with
`texra multi-agent run <team>`:

| Team               | For                                                                                         | Lead agent         |
| :----------------- | :------------------------------------------------------------------------------------------ | :----------------- |
| Lean Project       | Lean 4 projects — theorem search, tactic simplification, and blueprints                     | `leanOrchestrator` |
| Physicist          | Physics papers — derivations, numerical experiments, literature search, slides, and review  | `orchestrator`     |
| Mathematician      | Math research — attacking open problems, proofs, Lean 4 formalization, and LaTeX correction | `orchestrator`     |
| Computer Scientist | CS papers — algorithm design, code-driven experiments and ablations, tests, and review      | `orchestrator`     |
| Software Engineer  | A project's code — implementation, review, debugging, and testing across specialists        | `engineer`         |

Every team except Software Engineer bundles the `progressCheck` audit helper,
and the paper-focused teams also include `latexFixer`. The Software Engineer
lead and its specialists run locally; some specialists in other teams are
[remote agents](./remote-agents.md) that sync after you sign in.

## Next Steps

- [Agent Architecture](./agent-architecture.md) - How agents work internally
- [Research Tools](./research-tools.md) - Literature discovery and web tools
- [Custom Agents](./custom-agents.md) - Create your own agents
- [Models](./models.md) - AI model selection
