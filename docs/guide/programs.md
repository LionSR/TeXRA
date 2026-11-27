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

- **Starts a program**: a packaged job that checks its own work in code,
  such as a referee's annotations that must leave the text alone. The
  programs are listed below.
- **Hands part of the work to a helper agent** that it sets up for that job,
  with only the tools the job needs, and reads the result before relying on
  it. Several helpers can run in parallel; read
  [Multi-agent workflows](./multi-agent-workflows.md).

You can also start any program yourself, by name, from the terminal.

<AgentModeShapes />

<p class="hero-caption">A chat loops: the assistant converses and calls tools until the work is done. A program runs rounds of a helper agent and checks each round in code.</p>

## Starting a program

- **In a chat**: ask in plain words, for example "referee section 2 of
  main.tex", or name the program: "run the annotate program on main.tex". The
  assistant proposes the run. The proposal card shows the program, the
  instruction and the files; approve it, or select **Edit** to change them
  first.
- **From the terminal**: `texra run <program> --input <file>`, with an
  optional `--instruction`:

  ```bash
  texra run annotate --input paper.tex --instruction "Flag every unclear step in Section 3"
  texra run transcribe --input notes-page1.jpg --input notes-page2.jpg
  ```

  Every program needs at least one `--input` file. A name that is not a
  program prints the list of programs. Read the
  [CLI guide](./texra-cli.md#running-programs) for the other flags.

The assistant can start programs only while the **Multi-Agent Workflow**
plugin is on (**Settings → Plugins**, or `/plugins` in the terminal chat). It
is on by default.

## LaTeX programs

Both work on the files in your project directly, with the same file tools
the assistant uses. Nothing is staged for you to accept: review the changes
with your editor or `git diff`.

| Program      | What it does                                                                                       | What the instruction decides                                                                            |
| :----------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `annotate`   | Reviews the `.tex` files by adding `\\criticize{}` comments in place. It never rewrites.           | The point of view, for example a first-time reader. With none it reads as a referee of the mathematics. |
| `transcribe` | Turns media files into a new LaTeX file: handwriting or scans, or audio, by the media file's type. | The file to write, and anything specific about the content, such as who the speakers are.               |

### `annotate`

Each comment is `\\criticize{comment}{severity}{confidence}`, placed where the
issue is: severity runs from 5 (invalidates a main claim) down to 1
(cosmetic), with 0 for a point verified correct, and confidence from 1 (a
guess) to 5 (certain). After each round the program compares every file with
what it was when the program started: outside the comments and the macro's
definition nothing may differ. A round that changed anything else is followed
by another that is told to restore it, up to three rounds, and the answer
says so when the last round still failed.

```
Read as a first-time reader and mark every place where you lose the thread.
```

### `transcribe`

For images, converts handwritten or scanned mathematics into LaTeX that
matches the notation of the context files. For audio, writes a transcript
with timestamps, speaker labels, and spoken mathematics typeset as equations;
audio needs a model with native audio support (read
[Working with figures](./working-with-figures.md)). It writes
`transcript.tex` unless the instruction names another file, and never
overwrites a file that exists.

## Everything else: ask

There is no program for polishing or rewriting a draft, applying a review's
comments, making slides or a poster, auditing a manuscript, searching the
literature, deriving a result, running a numerical experiment, writing or
reviewing code, fixing a LaTeX build or diffing two versions with
`latexdiff`. Ask the assistant in plain words ("polish section 2 of main.tex
and show me the latexdiff", "turn this paper into a 15-slide Beamer deck",
"find recent papers on tensor-network contraction"). It edits the files in
place, compiles them and runs `latexdiff` itself; for a change it wants to
try several ways it works on copies of the project and keeps the best. It does the
work itself, or sets up a helper agent for it with the instructions and tools
that job needs; read [Multi-agent workflows](./multi-agent-workflows.md).

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
for what an agent used to do: reviewing, searching, proving, deriving,
numerics, coding, simplifying, testing, fixing LaTeX and `latexdiff` are
requests in plain words, not programs, and so are polishing, slide decks
and posters; the Lean agents' jobs are `prove`,
`lean-simplify` (was `leanSimplifier`), `lean-search` (was `leanSearch`) and
`blueprint`. Custom agent files are not read; see
[Tailoring TeXRA](./customizing.md).
:::

## Next steps

- [Programs: how they work](./agent-architecture.md): rounds, checks and run storage
- [Multi-agent workflows](./multi-agent-workflows.md): helper agents and scripts
- [Research tools](./research-tools.md): literature and computation
- [Models](./models.md): choosing a model
