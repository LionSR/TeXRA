<script setup>
import DropdownMenu from '../.vitepress/components/DropdownMenu.vue';
import AgentModeShapes from '../.vitepress/components/AgentModeShapes.vue';
</script>

# Built-in agent reference

TeXRA includes built-in agents for derivations, formal proofs, literature search, LaTeX debugging, figures, and code, and [programs](#programs): eight that revise or create LaTeX documents and two for Lean projects. Pick an agent from the dropdown menu in the TeXRA panel or run it from the CLI; start a program by asking an agent for the edit, or with `texra run <program>`.

<DropdownMenu
  label="Agent"
  value="orchestrator"
  valueIcon="robot"
  maxWidth="480px"
  columns="2"
  :groups="[
    {
      items: [
        { name: 'orchestrator', icon: 'robot', active: true },
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
  ]"
/>

<p class="hero-caption">The agent picker lists the chat agents enabled for the workspace (a few shown here). Programs are not in the picker: an agent starts one for you.</p>

The same catalog is available from any terminal with `texra agents list`: one tab-separated `name  description` row per agent, stable for scripts; `--all` includes hidden agents.

## Quick reference

An agent chats: it converses and calls its tools in a loop until the work is
done. A program is a fixed procedure over the files you name: it revises them
in a set number of revisions and hands back a versioned diff for you to accept.

<AgentModeShapes />

<p class="hero-caption">A chat loops: the agent converses and calls tools until done. A program revises the input files in fixed revisions and hands back a versioned diff.</p>

::: warning Prompts may change
The prompts and specific behaviors of these built-in agents may change slightly between TeXRA versions. If you need precise, unchanging behavior or want to customize the process in depth, create a [custom agent](./custom-agents.md) based on these examples.
:::

For the structure and execution flow common to all agents, read the [agent architecture guide](./agent-architecture.md).

## Conversational agents

### `assistant`

A general-purpose scientific assistant with the broadest toolset of any built-in agent. It can read your project, edit files, run shell commands, search the literature (arXiv, web), manage Zotero references, run Wolfram computations, work on Lean 4 proofs, and delegate to specialist agents or external AI coding agents (Codex, Claude Code), all in a back-and-forth conversation.

**Best for:** General research assistance, literature search, code/LaTeX editing, computations, running compilations

**Example instruction:**

```
Review my introduction in paper.tex and suggest improvements for clarity.
Then update the file with your changes.
```

## Problem-solving agents

### `prover`

A research mathematician for open and research-level problems: Erdős problems, conjectures posed at the end of papers, or questions from your own work. It checks the problem's current status in the literature first, computes small cases and hunts for counterexamples, lays out candidate lines of attack, and develops proofs lemma-by-lemma with adversarial self-verification. It reports honestly: SOLVED, DISPROVED, PARTIAL, or OPEN with the exact obstruction. Partial progress (special cases, reductions, improved bounds) is written up as such, never oversold.

**Best for:** Attacking open problems, counterexample searches, turning conjectures into verified partial results

**Example instruction:**

```
Attack the open problem stated in problem.tex. Check its current status on
erdosproblems.com and arXiv first, compute small cases, then either prove it,
disprove it, or report the strongest partial result you can rigorously verify.
```

## Research & discovery agents

### `research`

A hands-on research agent that can edit your files **and** verify mathematics computationally. Use it when you need to check a derivation or run a symbolic calculation alongside your writing.

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

## Verification agents

### `review`

A scientific auditor that verifies your research manuscript. It checks mathematical correctness, derivation soundness, notation consistency, code-manuscript agreement, and goal achievement, using Wolfram for computational verification.

**Best for:** Pre-submission audits, mathematical verification, notation consistency checks

**Example instruction:**

```
Audit this manuscript: verify every derivation step-by-step, check notation
consistency across all sections, and confirm that every stated goal in the
abstract is actually delivered in the paper.
```

## Formal methods agents

### `lean`

Helps you write and debug Lean 4 proofs. It reads compiler diagnostics, inspects proof state, and iterates until the proof compiles.

**Best for:** Formalizing proofs, Lean 4 development, Mathlib projects

**Example instruction:**

```
Formalize the proof of the theorem in Proofs/GroupTheory.lean. Start with an
informal outline, then produce Lean code and iterate until it compiles.
```

## Presentation & simplification agents

### `presenter`

Builds and refines LaTeX Beamer presentations, posters, and other visual materials for scientific code, methods, and results, working interactively with you. It reads your project and any template you provide, plans the deck, writes and compiles the slides, generates figures by running code, and visually checks every compiled page (overflow, overlaps, unreadable text, broken TikZ) until the output is clean. To convert a finished paper into a deck without the back-and-forth, use the [`slides` program](#programs).

**Best for:** Conference talks, seminar presentations, lightning talks

**Example instruction:**

```
Create a 15-slide Beamer presentation from this project. Cover motivation, the core
algorithm, key results, and future work. Use the metropolis theme and include TikZ
diagrams for the architecture.
```

## Programs

The `theory` plugin ships eight programs. Each takes input files and an
optional instruction; the instruction decides how far the program goes and
from which point of view it reads.

| Program      | What it does                                                                                       | What the instruction decides                                                                                               |
| :----------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `edit`       | Rewrites the documents.                                                                            | How far to go: a proofread, a polish for clarity and flow, or new and expanded content. With no instruction it proofreads. |
| `annotate`   | Reviews the documents by adding `\criticize{}` comments. It never rewrites.                        | The point of view, for example a first-time reader. With none it reads as a referee of the mathematics.                    |
| `enhance`    | Improves the substance: makes the changes it can carry out in full and annotates the rest.         | What to look at: the mathematics, the logical structure, or the notation.                                                  |
| `apply`      | Implements the fixes that inline comments from an earlier review ask for.                          | Which comments to handle. With none it handles them all.                                                                   |
| `merge`      | Merges a partial edit back into the full original document.                                        | Started by the [Merge action](./intelligent-merge.md).                                                                     |
| `transcribe` | Turns media files into a LaTeX document: handwriting or scans, or audio, by the media file's type. | Anything specific about the content, such as who the speakers are.                                                         |
| `slides`     | Turns a paper into a Beamer slide deck on the bundled template.                                    | Length, emphasis and audience.                                                                                             |
| `poster`     | Turns a paper into a Beamer poster on the bundled template.                                        | Emphasis and audience.                                                                                                     |

A point of view is a sentence of the instruction, not a separate program:
"read as a first-time reader" for `annotate`, "check that the notation is
consistent" for `enhance`. A typical loop is `annotate`, then `apply`.

### Starting a program

- **In the app**: ask an agent in plain words, for example "polish section 2
  of main.tex" to the default `orchestrator` (or to `assistant`). The agent
  proposes a `program` run; the proposal card shows the program, the
  instruction and the files, and you can edit them before you approve.
- **From the terminal**: `texra run <program> --input <file>`, with an
  optional `--instruction`:

  ```bash
  texra run edit --input paper.tex --instruction "Polish the introduction"
  texra run annotate --input paper.tex --instruction "Read as a first-time reader"
  ```

  Read the [CLI guide](./texra-cli.md#running-agents) for the other flags.

- **From a script**: `program('edit', { prompt, inputFiles })`; read
  [Multi-agent workflows](./multi-agent-workflows.md).

Programs are part of the **Multi-Agent Workflow** plugin's `program` tool, so
an agent can start one only while that plugin is enabled.

The Lean plugin adds two more: `prove` completes the proofs in `.lean` files
until Lean reports no error and no `sorry`, and `blueprint` writes or updates
a LeanBlueprint document until `leanblueprint web` and `leanblueprint checkdecls`
pass. Read
[Lean 4 proofs](./lean.md#lean-programs).

### `edit`

**Best for:** Proofreading before submission, tightening prose whose math and structure are settled, adding a derivation the draft skips

**Example instructions:**

```
Fix typos, grammar and LaTeX syntax. Do not change the technical content or the writing style.
```

```
Polish the introduction for clarity and flow. Keep every equation and citation.
```

```
Expand the derivation of equation (12), showing every intermediate step.
```

#### Example output

A polish of the [sample document](/examples/draft.pdf) produces a color-coded diff showing exactly what changed: versioned output files, with latexdiff highlighting additions in blue and deletions in red.

<div class="agent-pdf-viewer">
  <iframe src="/examples/draft_polish_r1_gemini25p_diff.pdf" title="Polish example" class="agent-pdf-frame"></iframe>
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

### `annotate`

Each comment is `\criticize{comment}{severity}{confidence}`, placed where the issue is: severity runs from 5 (invalidates a main claim) down to 1 (cosmetic), with 0 for a point verified correct, and confidence from 1 (a guess) to 5 (certain). The program checks that a revision changed nothing outside its comments.

**Example instruction:**

```
Read as a first-time reader and mark every place where you lose the thread.
```

### `enhance`

Marks each change it made with a comment that starts with "Implemented:" and each improvement it left to the authors with one that starts with "Suggestion:".

**Example instruction:**

```
Make the notation consistent across the sections and the appendix.
```

### `apply`

Reads `\criticize{}`, `\todo{}`, `\comment{}` and `%` comments, applies the fix each asks for, and removes a comment once it is handled. A comment it cannot resolve stays in place.

**Example instruction:**

```
Handle only the comments with severity 3 or higher.
```

### `transcribe`

For images, converts handwritten or scanned mathematics into LaTeX that matches the notation of the context documents. For audio, writes a transcript with timestamps, speaker labels, and spoken mathematics typeset as equations; audio needs a model with native audio support (read [Working with figures](./working-with-figures.md)). The output is `transcript.tex`.

**Example instruction:**

```
The recording is a lecture with questions from the audience. Label the speakers Lecturer and Questioner 1, 2, ...
```

### `slides` and `poster`

Each writes a draft, then reviews and fixes it. `slides` writes `slides.tex`, a deck of 10 to 15 slides unless the instruction says otherwise; `poster` writes `poster.tex`.

**Example instruction:**

```
A 20-minute seminar talk for non-specialists: spend more slides on motivation and state the main theorem without its proof.
```

### `merge`

Takes a partially edited document (one that shows only the changed parts and marks the rest "unchanged") and rebuilds the complete document: it applies every edit as written and copies the unchanged parts from your original verbatim, preserving the structure so latexdiff can compare the versions. Read [Intelligent merge](./intelligent-merge.md) for the workflow.

::: tip Creating figures
To generate or improve TikZ figures, chat with `research` or `presenter` and describe the figure. The agent writes compilable TikZ, compiles it, and visually verifies the result. Read [Working with figures](./working-with-figures.md) and [TikZ figures](./tikz-figures.md).
:::

## LaTeX & build agents

### `latexFixer`

Diagnoses and fixes LaTeX compilation errors, warnings, and bad boxes. Point it at a project that does not compile (or compiles with overfull boxes) and it reads the build log, locates the cause, and iterates until the document is clean.

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

## Software engineering agents

These agents work on the code that accompanies a project: simulations,
numerics, data pipelines, scripts, and small libraries. `engineer` leads the
other four.

### `engineer`

The [lead agent](#lead-agents) for code. Turns a coding goal into focused tasks, delegates each to the right specialist, reviews their work, and keeps the codebase coherent.

**Best for:** Multi-step coding goals you want planned, delegated, and verified end to end

**Example instruction:**

```
Speed up scripts/simulate.py without changing its results. Profile it first,
then optimize the hot loops, and make sure the regression tests still pass.
```

### `coder`

Implements features, makes focused edits, and fixes bugs, then verifies the change builds and passes the project's checks.

**Best for:** Implementation, focused edits, bug fixes

### `codeReviewer`

Reviews a diff or file for correctness, clarity, security, and convention fit, and reports prioritized findings. It is read-only and does not edit.

**Best for:** Pre-merge review, auditing generated code

### `testEngineer`

Writes and maintains tests: pins down existing behavior, covers new code and edge cases, and keeps the suite fast and reliable.

**Best for:** Adding coverage, characterization tests, keeping suites healthy

### `codeSimplifier`

Refactors working code for clarity, reuse, and efficiency without changing its behavior, then confirms the tests still pass. It works on quality only and does not hunt for bugs.

**Best for:** Behavior-preserving cleanup of research code

## Setup & meta agents

### `setup`

A setup wizard that diagnoses your environment, installs missing dependencies, configures TeXRA, and orchestrates your first task. If you are new to TeXRA or moving to a new machine, start with this agent.

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

## Orchestration, search & audit agents

These agents ship with TeXRA and need no sign-in.

### `search`

Finds papers and web content for you. Give it a topic and it comes back with relevant preprints, published articles, and web resources. It is read-only and does not change your files.

**Best for:** Literature reviews, finding citations, fact-checking

**Example instruction:**

```
Find recent papers on transformer architectures for scientific document understanding.
Focus on papers from 2023-2024 that address mathematical equation handling.
```

### `simplifier`

Removes complexity from your code and writing: duplicated logic across files, over-abstract wrappers, or LLM-generated filler prose. `simplifier` cleans them up while preserving correctness.

**Best for:** Refactoring research code, tightening manuscript prose, cleaning up verbose AI-generated text

**Example instruction:**

```
Simplify the numerical solver in solver.py. Look for duplicated code, inline any
single-use helper functions, and remove dead code. Run existing tests after each change.
```

### `orchestrator`

Coordinates multi-agent work on LaTeX research projects. It reads project context, turns broad goals into focused tasks, routes each task to the right specialist, tracks results, reviews generated files, and keeps follow-up work organized. The [lead agent](#lead-agents) for research projects.

**Best for:** Multi-step research goals that span several specialists

### `progressCheck`

An end-of-session reviewer. It looks at what was just done and, when the session changed files or depends on wider project context, the project's standing goal and git/PR state. For self-contained read-only work, it stays with the request and the named agent reports. It is read-only: it advises, but does not edit or delegate.

**Best for:** Auditing what a multi-agent run actually delivered versus the goal

## Lead agents

Three agents lead multi-agent work. Each plans the task, delegates the pieces
to the other agents your workspace shows, and reviews what comes back; each
can also run its specialists in parallel as a
[multi-agent workflow](./multi-agent-workflows.md).

| Lead               | For                                                                                          |
| :----------------- | :------------------------------------------------------------------------------------------- |
| `orchestrator`     | Research projects: derivations, numerical experiments, literature search, review, and slides |
| `leanOrchestrator` | Lean 4 projects: theorem search, tactic simplification, and blueprints                       |
| `engineer`         | A project's code: implementation, review, debugging, and testing                             |

A workspace shows every agent. To shorten the agent menu and the list a lead
delegates from, turn agents off in the **Library** section of the **Agents**
tab in Settings.

## Next steps

- [Agent architecture](./agent-architecture.md): how agents work internally
- [Research tools](./research-tools.md): literature discovery and web tools
- [Custom agents](./custom-agents.md): create your own agents
- [Models](./models.md): AI model selection
