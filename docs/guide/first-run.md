<script setup>
import FlowSteps from '../.vitepress/components/FlowSteps.vue';
import PolishRunTree from '../.vitepress/components/PolishRunTree.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
</script>

# First run

You have TeXRA installed. This page walks you through running one
agent — `polish` — on a real `.tex` file. About five minutes,
side-by-side for the extension and the CLI.

If you don't have TeXRA yet, see [Installation](./installation.md).

::: tip Fresh install?
On a fresh install, the setup assistant offers to run exactly this flow
conversationally — it checks your environment, asks what you're working
on, and runs this same polish demo, ending at the diff. This page is the
manual mirror of that conversation.
:::

## Step 0: add a key or connect a subscription

A credential is the one step no agent can do for you. Three ways in:

- **Use your own provider API key** — Anthropic, OpenAI, Google, and
  more. See
  [Quick start → Add a key or connect a subscription](./quick-start.md#add-a-key-or-connect-a-subscription).
- **Use ChatGPT subscription** — Codex models through your ChatGPT plan.
  In VS Code, open **Settings → Subscriptions** and use the ChatGPT
  sign-in section; in the terminal, run `texra auth chatgpt login`.
  Grok, Kimi Code, and the GLM Coding Plan connect from the same place.
- **Use GitHub Copilot in VS Code** — compatible models through your Copilot
  subscription. Open **Settings → Subscriptions → Copilot in VS Code** and grant
  access in the native VS Code prompt. No provider API key is needed. This
  source is unavailable in the terminal and desktop applications.

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
2. Click the TeXRA icon in the Secondary Side Bar.
3. In the **Input** section, click <wa-icon library="texra" name="add"></wa-icon> **Add files** and pick `draft.tex` from the file picker.
4. Pick **polish** under Agent. Pick **sonnet5T** under Model (or any
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

<CliRunHero
  command='texra run polish --input draft.tex --instruction "Tighten the prose. Preserve all math and citations."'
  :rounds="[
    { label: 'Round 0 — draft  ·  r0/draft.tex written', state: 'done' },
    { label: 'Round 1 — critique, rereading its own output', state: 'active' },
  ]"
/>

<p class="hero-caption">Mid-run: Round 0 has written the first revision, Round 1 is critiquing and revising it — the live status line on stderr tracks the current round. When the run completes, the path to the final document prints on stdout.</p>

The run streams reasoning, tool calls, and the assembled output.
When it completes, polish has written one folder per round in the run's
storage folder (`executions/<run-id>/` under TeXRA's workspace storage):

<PolishRunTree />

<p class="hero-caption">Each round lands in its own folder and keeps the input filename — <code>r0/draft.tex</code> is the first revision, <code>r1/draft.tex</code> the critique pass and final. Add <code>--output draft.polished.tex</code> to write the result next to your input instead.</p>

To diff against your original, use the final-document path printed on
stdout:

```sh
diff -u draft.tex <path-to-r1/draft.tex-from-stdout>
```

## What just happened

Polish ran two passes: a first revision, then a critique pass that
rereads its own output and revises again.

<FlowSteps :steps="[
  { n: 1, icon: 'wand', title: 'Round 0 — draft', desc: 'Reads draft.tex, applies your instruction, writes the first revision.', chips: [{ text: 'r0/draft.tex', variant: 'info', icon: 'file-code' }] },
  { n: 2, icon: 'search', title: 'Round 1 — critique', desc: 'Rereads its own Round 0 output, then revises again.', chips: [{ text: 'missing math', variant: 'warning' }, { text: 'weakened sentences', variant: 'warning' }, { text: 'generic filler', variant: 'warning' }, { text: 'out-of-scope edits', variant: 'warning' }, { text: 'r1/draft.tex', variant: 'info', icon: 'file-code' }] }
]" />

<p class="hero-caption">Polish is a two-pass workflow: Round 0 drafts from your instruction, Round 1 critiques its own output against a fixed checklist and revises into <code>r1/draft.tex</code>.</p>

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
