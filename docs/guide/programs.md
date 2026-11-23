<script setup>
import AgentModeShapes from '../.vitepress/components/AgentModeShapes.vue';
</script>

# The assistant and programs

TeXRA has one assistant. You start every task the same way: open the TeXRA
panel (or run `texra` in a terminal), say what you want and on which files,
and send it. There is nothing to pick first.

The assistant reads your project, edits files, runs shell commands, searches
arXiv, the web and your Zotero library, runs Wolfram and Python computations,
works on Lean 4 proofs, and compiles your documents. For a larger job it does
one of two things:

- **Starts a program**: a packaged job with a fixed procedure, such as a
  whole-document polish or a manuscript audit. The programs are listed below.
- **Hands part of the work to a helper agent** that it sets up for that job,
  with only the tools the job needs, and reads the result before relying on
  it. Several helpers can run in parallel; read
  [Multi-agent workflows](./multi-agent-workflows.md).

You can also start any program yourself, by name, from the terminal.

<AgentModeShapes />

<p class="hero-caption">A chat loops: the assistant converses and calls tools until the work is done. A document program revises the input files in fixed revisions and hands back a versioned diff.</p>

## Starting a program

- **In a chat**: ask in plain words, for example "polish section 2 of
  main.tex", or name the program: "run the review program on main.tex". The
  assistant proposes the run. The proposal card shows the program, the
  instruction and the files; approve it, or select **Edit** to change them
  first.
- **From the terminal**: `texra run <program> --input <file>`, with an
  optional `--instruction`:

  ```bash
  texra run edit --input paper.tex --instruction "Polish the introduction"
  texra run review --input paper.tex --instruction "Check every derivation in Section 3"
  ```

  Every program needs at least one `--input` file. A name that is not a
  program prints the list of programs. Read the
  [CLI guide](./texra-cli.md#running-programs) for the other flags.

The assistant can start programs only while the **Multi-Agent Workflow**
plugin is on (**Settings → Plugins**, or `/plugins` in the terminal chat). It
is on by default.

## Document programs

These revise or create LaTeX documents. Each runs a fixed number of
revisions, compiles and diffs every revised `.tex` file, and proposes the
result for you to accept. The instruction decides how far the program goes
and from which point of view it reads.

| Program      | What it does                                                                                       | What the instruction decides                                                                                               |
| :----------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `edit`       | Rewrites the documents.                                                                            | How far to go: a proofread, a polish for clarity and flow, or new and expanded content. With no instruction it proofreads. |
| `annotate`   | Reviews the documents by adding `\criticize{}` comments. It never rewrites.                        | The point of view, for example a first-time reader. With none it reads as a referee of the mathematics.                    |
| `enhance`    | Improves the substance: makes the changes it can carry out in full and annotates the rest.         | What to look at: the mathematics, the logical structure, or the notation.                                                  |
| `apply`      | Implements the fixes that inline comments from an earlier review ask for.                          | Which comments to handle. With none it handles them all.                                                                   |
| `transcribe` | Turns media files into a LaTeX document: handwriting or scans, or audio, by the media file's type. | Anything specific about the content, such as who the speakers are.                                                         |
| `slides`     | Turns a paper into a Beamer slide deck on the bundled template.                                    | Length, emphasis and audience.                                                                                             |
| `poster`     | Turns a paper into a Beamer poster on the bundled template.                                        | Emphasis and audience.                                                                                                     |

A point of view is a sentence of the instruction, not a separate program:
"read as a first-time reader" for `annotate`, "check that the notation is
consistent" for `enhance`. A typical loop is `annotate`, then `apply`. Read
[Programs: how they work](./agent-architecture.md) for the revisions, the
optional critic and where the files land.

### `edit`

**Best for:** proofreading before submission, tightening prose whose math and structure are settled, adding a derivation the draft skips.

```
Fix typos, grammar and LaTeX syntax. Do not change the technical content or the writing style.
```

```
Expand the derivation of equation (12), showing every intermediate step.
```

A polish of the [sample document](/examples/draft.pdf) produces a color-coded
diff of exactly what changed, with additions in blue and deletions in red:

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

Each comment is `\criticize{comment}{severity}{confidence}`, placed where the
issue is: severity runs from 5 (invalidates a main claim) down to 1
(cosmetic), with 0 for a point verified correct, and confidence from 1 (a
guess) to 5 (certain). The program checks that a revision changed nothing
outside its comments.

```
Read as a first-time reader and mark every place where you lose the thread.
```

### `enhance`

Marks each change it made with a comment that starts with "Implemented:" and
each improvement it left to the authors with one that starts with
"Suggestion:".

```
Make the notation consistent across the sections and the appendix.
```

### `apply`

Reads `\criticize{}`, `\todo{}`, `\comment{}` and `%` comments, applies the
fix each asks for, and removes a comment once it is handled. A comment it
cannot resolve stays in place.

```
Handle only the comments with severity 3 or higher.
```

### `transcribe`

For images, converts handwritten or scanned mathematics into LaTeX that
matches the notation of the context documents. For audio, writes a transcript
with timestamps, speaker labels, and spoken mathematics typeset as equations;
audio needs a model with native audio support (read
[Working with figures](./working-with-figures.md)). The output is
`transcript.tex`.

### `slides` and `poster`

Each writes a draft, then reviews and fixes it. `slides` writes `slides.tex`,
a deck of 10 to 15 slides unless the instruction says otherwise; `poster`
writes `poster.tex`.

```
A 20-minute seminar talk for non-specialists: spend more slides on motivation and state the main theorem without its proof.
```

## Task programs

Each of these hands the job to one helper agent, told the checklist for that
job and given the tools it needs, and answers with that agent's report. File
edits it makes are approved like any other edit. The instruction says what to
work on; `--input` names the files.

| Program       | What it does                                                                                                                                                             | Edits files     |
| :------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------- |
| `review`      | Audits a manuscript: reproduces key derivations, checks limiting cases and dimensions, notation, references, figures, and that code matches the text.                    | Only if asked   |
| `search`      | Finds and synthesizes literature and web sources, citing each with its URL, DOI or arXiv ID; it can add papers to Zotero and download arXiv sources.                     | No              |
| `derive`      | Carries out an analytical derivation or symbolic computation, with Wolfram Language through `wolframscript` where it helps, and verifies the result.                     | Yes             |
| `solve`       | Attacks a research-level or open problem: surveys what is known, computes small cases, hunts for counterexamples, and writes a proof, disproof or scoped partial result. | Yes             |
| `experiment`  | Designs, runs and validates a numerical experiment (a simulation, a convergence study, a reproduction of a figure) and reports what it shows.                            | Yes             |
| `code`        | Implements a feature, makes a targeted edit or fixes a bug in the project's code, then runs its build and tests.                                                         | Yes             |
| `review-code` | Reviews a diff or the named files for correctness, clarity and security, and answers with prioritized findings.                                                          | No              |
| `simplify`    | Simplifies working code or LaTeX without changing what it does, then confirms the tests or the build still pass.                                                         | Yes             |
| `test`        | Writes or repairs tests with the project's own framework and runs them.                                                                                                  | Yes             |
| `fix-latex`   | Diagnoses and fixes compilation errors, broken references and citations, warnings and bad boxes so the document builds.                                                  | Yes, in place   |
| `latexdiff`   | Produces a compiled visual diff of two versions of a LaTeX document with `latexdiff`; the old and new files are the inputs.                                              | Writes the diff |

Examples:

```bash
texra run review --input paper.tex --instruction "Confirm every goal the abstract states is delivered"
texra run solve --input problem.tex --instruction "Check the problem's status in the literature first"
texra run experiment --input solver.py --instruction "Sweep the step size and report the observed order of accuracy"
texra run fix-latex --input main.tex
texra run latexdiff --input v1/main.tex --input main.tex
```

In a chat you rarely need to name them: "audit this manuscript" or "find
recent papers on tensor-network contraction" is enough, and the assistant
decides whether to do the work itself or start the program.

## Lean programs

The Lean plugin adds four: `prove` completes the proofs in `.lean` files
until Lean reports no error and no `sorry` and the files declare no new
`axiom`; `lean-simplify` brings them toward Mathlib quality without changing
what they state, under the same check; `blueprint` writes or updates a
LeanBlueprint document until `leanblueprint web` and
`leanblueprint checkdecls` pass; and `lean-search` finds what Mathlib and the
project already have for a statement or an API and says what is missing.
Read [Lean 4 proofs](./lean.md#lean-programs).

## Your own programs

A plugin can carry programs of its own, and the assistant can write a
program for itself that it reuses in later conversations. Read
[Tailoring TeXRA](./customizing.md).

::: info If you used 0.40
There is no agent menu any more, and no `--agent` flag. Ask the assistant
for what an agent used to do, or start the matching program: `review`,
`search`, `solve` (was `prover`), `derive` (was `research`), `experiment`
(was `numerics`), `code` (was `coder` and `engineer`), `review-code`,
`simplify`, `test`, `fix-latex` (was `latexFixer`) and `latexdiff`. Slide
decks and posters are the `slides` and `poster` programs; the Lean agents'
jobs are `prove`, `lean-simplify` (was `leanSimplifier`), `lean-search` (was
`leanSearch`) and `blueprint`. Custom agent files are not read; see
[Tailoring TeXRA](./customizing.md).
:::

## Next steps

- [Programs: how they work](./agent-architecture.md): revisions, the critic, and run storage
- [Multi-agent workflows](./multi-agent-workflows.md): helper agents and scripts
- [Research tools](./research-tools.md): literature and computation
- [Models](./models.md): choosing a model
