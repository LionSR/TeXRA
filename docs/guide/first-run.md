# First run

This walkthrough runs your first task, a polish of a `.tex` file, and shows how to inspect what changed in VS Code or the terminal. It takes under five minutes.

If you don't have TeXRA yet, read the [installation guide](./installation.md).

::: tip Fresh install?
On a fresh install, the setup assistant offers to run this flow
conversationally: it checks your environment, asks what you're working
on, and runs the same polish demo, ending at the diff. Start it any time
with **TeXRA: Run Setup Assistant** from the Command Palette in VS Code,
or `texra setup` in the terminal. This page is the manual mirror of that
conversation.
:::

## Step 0: add a key or connect a subscription

A credential is the one step no agent can do for you. Two ways in:

- **Use your own provider API key**: Anthropic, OpenAI, Google, and
  more. Read
  [Quick start: add a key or connect a subscription](./quick-start.md#add-a-key-or-connect-a-subscription).
- **Use a ChatGPT subscription**: OpenAI models through your ChatGPT plan.
  In VS Code, open **Settings → Models → Subscriptions** and use the
  ChatGPT sign-in section; in the terminal, run `texra auth chatgpt login`.
  Grok connects from the same place; Kimi Code and the GLM Coding Plan take
  a key under **Settings → Models → API keys**.

## Get a sample file

If you already have a working draft, skip this step.
Otherwise:

### In VS Code

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
**`TeXRA: Create Sample Project`**. This creates a ready-to-run
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

## Run a polish

### In VS Code

1. Open the folder that holds `draft.tex`.
2. Select the TeXRA icon in the Secondary Side Bar.
3. Pick
   **Sonnet 5.5** (`anthropic/claude-sonnet-5-5`) from the **Model** menu (or any available model).
4. Type an instruction that names the file:
   > Polish draft.tex: tighten the prose. Preserve all math and citations.
5. Select **Start task** (the arrow button).

The Tasks view opens and streams the run. The assistant reads `draft.tex`,
edits it in place and compiles it; each edit asks for your approval with a
preview of the change. When it finishes, review the file in the editor or
with `git diff`.

### In the terminal

```bash
texra run chat \
  --instruction "Polish draft.tex: tighten the prose. Preserve all math and citations." \
  --print
git diff draft.tex
```

## What just happened

The assistant worked as a person would: it read the file, made its edits
with its file tools, and compiled the result. For a job with a check that
must hold, such as a referee's comments that leave the text alone, it starts
a [program](./programs.md):

```bash
texra run annotate --input draft.tex --instruction "Read as a first-time reader"
```

## Next steps

- [**Polish a draft**](./workflows/polish-a-draft.md): how to ask for a careful polish
- [**The assistant and programs**](./programs.md): what you can ask for, and every program you can start
- [**Models**](./models.md): choosing a model that matches the work
- [**TeXRA CLI**](./texra-cli.md): sign-in, project defaults, headless output formats
- [**LaTeX Diff**](./latex-diff.md): a marked-up PDF of what changed
