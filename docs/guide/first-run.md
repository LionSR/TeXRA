# First run

You have TeXRA installed. This page walks you through running one
agent — `polish` — on a real `.tex` file. About five minutes,
side-by-side for the extension and the CLI.

If you don't have TeXRA yet, see [Installation](./installation.md).

## What you'll do

1. Get a sample `.tex` file.
2. Run the `polish` agent with one instruction.
3. Read the diff.

## Get a sample file

If you already have a draft you want to polish, skip this step.
Otherwise:

### In VS Code

Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
**`TeXRA: Create Sample Project`**. This drops a ready-to-run
workspace at `texra-sample/draft.tex`.

### In the terminal

Any `.tex` file works. If you want a quick test file:

```sh
cat > draft.tex <<'EOF'
\documentclass{article}
\begin{document}
The proposed method achieves significant improvements over the baseline,
which is something that is very important for the field, and we will
demonstrate this in the following sections through various experiments.
\end{document}
EOF
```

## Run polish

### In VS Code

1. Open `draft.tex`.
2. Click the TeXRA icon in the activity bar.
3. With `draft.tex` open in the editor, click <wa-icon library="texra" name="folder-opened"></wa-icon> **Add opened files** in the **Input** section.
4. Pick **polish** under Agent. Pick **sonnet46T** under Model (or any
   available model).
5. Type an instruction:
   > Tighten the prose. Preserve all math and citations.
6. Press **Execute**.

The Progress Board opens and streams the run. When it finishes, a
**diff** icon appears on the completed stream — click it to see what
changed.

### In the terminal

```sh
texra run polish \
  --input draft.tex \
  --instruction "Tighten the prose. Preserve all math and citations."
```

The run streams reasoning, tool calls, and the assembled output.
When it completes, polish has written:

```
.texra/runs/<run-id>/r0/draft.tex   # First revision
.texra/runs/<run-id>/r1/draft.tex   # Critique pass
```

(The input filename is preserved — not `output.tex`.)

To diff against your original:

```sh
diff -u draft.tex .texra/runs/<run-id>/r1/draft.tex
```

To write the final result next to your input instead of into task
storage, add `--output draft.polished.tex` to the command.

## What just happened

Polish ran two passes:

- **Round 0** — read your file, applied your instruction, wrote the
  first revision.
- **Round 1** — reread its own Round 0 output, checked for missing
  math, weakened sentences, generic filler, and out-of-scope changes,
  then revised again.

Workflow agents like `polish` do not call tools. They read input, run
their pipeline, and write a diff. The next step up — tool-use agents
— can read across your project, search literature, compile LaTeX, and
verify their work; see [Built-in Agents](./built-in-agents.md).

## Next steps

- [**Polish a draft**](./workflows/polish-a-draft.md) — the workflow in depth: rounds, limits, multi-file projects
- [**Built-in Agents**](./built-in-agents.md) — the full catalog, including `correct`, `research`, `review`, and `lean`
- [**Models**](./models.md) — choosing a model that matches the work
- [**TeXRA CLI**](./texra-cli.md) — sign-in, workspace defaults, headless output formats
- [**LaTeX Diff**](./latex-diff.md) — compiled PDF comparison of revisions
