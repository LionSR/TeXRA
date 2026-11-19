<script setup>
import FlowSteps from '../.vitepress/components/FlowSteps.vue';
import PolishRunTree from '../.vitepress/components/PolishRunTree.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
</script>

# First run

This walkthrough runs your first program—a polish with `edit`—on a `.tex` file and shows how to inspect the resulting diff in VS Code or the terminal. It takes under five minutes.

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
3. Keep the default agent in the **Agent** menu and pick
   **Sonnet 5.5** (`anthropic/claude-sonnet-5-5`) from the **Model** menu (or any available model).
4. Type an instruction that names the file:
   > Polish draft.tex: tighten the prose. Preserve all math and citations.
5. Select **Start task** (the arrow button).
6. The agent proposes an `edit` run on `draft.tex`. Check the files and the
   instruction on the proposal card, then approve it.

The ProgressBoard opens and streams the run. When it finishes, the
revised file is listed under **Generated files**. Select its
**Compare with base** button to see what changed.

### In the terminal

```sh
texra run edit \
  --input draft.tex \
  --instruction "Tighten the prose. Preserve all math and citations."
```

<CliRunHero
  command='texra run edit --input draft.tex --instruction "Tighten the prose. Preserve all math and citations."'
  :rounds="[
    { label: 'Revision 1: draft  ·  r0/draft.tex written', state: 'done' },
    { label: 'Revision 2: review, rereading its own output', state: 'active' },
  ]"
/>

<p class="hero-caption">Mid-run: the first revision is written and the second is reviewing and correcting it. Progress lines on stderr name the current revision. When the run completes, the full path to the final document prints on stdout.</p>

The run prints its progress on stderr.
When it completes, `edit` has written one folder per revision in the run's
storage folder (`executions/<run-id>/` in the project's storage under `~/.texra`):

<PolishRunTree />

<p class="hero-caption">Each revision lands in its own folder and keeps the input filename: <code>r0/draft.tex</code> is the first revision, <code>r1/draft.tex</code> the review pass and final. Add <code>--output draft.polished.tex</code> to write the result next to your input instead.</p>

To diff against your original, use the final-document path printed on
stdout:

```sh
diff -u draft.tex <path-to-r1/draft.tex-from-stdout>
```

## What just happened

`edit` ran two passes: a first revision, then a review pass that
rereads its own output and corrects it.

<FlowSteps :steps="[
  { n: 1, icon: 'wand', title: 'Revision 1: draft', desc: 'Reads draft.tex, applies your instruction, writes the first revision.', chips: [{ text: 'r0/draft.tex', variant: 'info', icon: 'file-code' }] },
  { n: 2, icon: 'search', title: 'Revision 2: review', desc: 'Rereads its own first revision against the original, then corrects it.', chips: [{ text: 'missing math', variant: 'warning' }, { text: 'notation before definition', variant: 'warning' }, { text: 'generic filler', variant: 'warning' }, { text: 'out-of-scope edits', variant: 'warning' }, { text: 'r1/draft.tex', variant: 'info', icon: 'file-code' }] }
]" />

<p class="hero-caption"><code>edit</code> is a two-revision program: the first revision drafts from your instruction, the second reviews its own output against a fixed checklist and corrects it into <code>r1/draft.tex</code>.</p>

A program like `edit` does not call tools. It reads input, runs
its revisions, and writes a diff. Agents with tools
can read across your project, search literature, verify algebra in
Wolfram, prove theorems in Lean 4, and compile LaTeX. Read the
[built-in agents catalog](./built-in-agents.md).

## Next steps

- [**Polish a draft**](./workflows/polish-a-draft.md): the `edit` program in depth: revisions, limits, multi-file projects
- [**Built-in agents**](./built-in-agents.md): the full catalog, including the programs and the `research`, `review`, and `lean` agents
- [**Models**](./models.md): choosing a model that matches the work
- [**TeXRA CLI**](./texra-cli.md): sign-in, workspace defaults, headless output formats
- [**LaTeX Diff**](./latex-diff.md): compiled PDF comparison of revisions
