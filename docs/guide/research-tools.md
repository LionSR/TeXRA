# Research tools

<script setup>
import SearchResultsHero from '../.vitepress/components/SearchResultsHero.vue';
import CliSearchChatHero from '../.vitepress/components/CliSearchChatHero.vue';
</script>

TeXRA's research agents connect to arXiv, Zotero, DuckDuckGo, WolframScript, and Lean 4 so you can search literature, manage BibTeX references, and check symbolic or formal math from your workspace.

<wa-callout variant="brand">
  <wa-icon slot="icon" library="texra" name="shield"></wa-icon>
  Every citation comes from a real <strong>arXiv</strong> lookup or your <strong>Zotero</strong> library. TeXRA's research agents search grounded sources and never fabricate references.
</wa-callout>

## What you can do

### <wa-icon library="texra" name="mortar-board"></wa-icon> Find papers

Ask `search` or `assistant` to find papers. They search **arXiv**, the web, and your Zotero library (`presenter` searches arXiv and the web, `review` arXiv only):

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

<SearchResultsHero />

<p class="hero-caption">A typical <code>search</code> result set: each preprint carries its title, authors, and an arXiv source tag. Every row is a real lookup, never fabricated.</p>

The same search streams in a terminal, with each lookup shown as a tool call:

<CliSearchChatHero />

<p class="hero-caption">A search in <code>texra chat --agent search</code>: each grounded lookup surfaces as a tool-call row, with results streaming under it.</p>

### <wa-icon library="texra" name="cloud-download"></wa-icon> Download paper sources

For deeper analysis, ask to download the LaTeX source of a paper:

```
Download the source files for arxiv:2401.12345 so I can see how they made their figures.
```

This uses the `download_arxiv_source` tool and places the files in your workspace.

### <wa-icon library="texra" name="globe"></wa-icon> Search the web

For documentation, project pages, or general information:

```
Find the official PyTorch documentation for attention mechanisms.
```

The `web_search` tool queries the DuckDuckGo Instant Answers API, not a model provider's hosted search. `web_fetch` retrieves a specific URL and returns the page as clean text.

### <wa-icon library="texra" name="book"></wa-icon> Manage references with Zotero

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library directly. Keep Zotero running while you use these features; check its status and switch it on under **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>).

```
Search my Zotero library for papers on attention mechanisms.
```

```
Export the selected Zotero items as a .bib file for my project.
```

```
Add this arXiv paper to my Zotero library.
```

<ToolCallPanel
  title="zotero"
  icon="book"
  :calls="[
    { state: 'done', verb: 'zotero_search', target: 'graph neural networks', effect: 'Finds matching items in your library' },
    { state: 'done', verb: 'zotero_add', target: 'arxiv.org/abs/2401.12345', effect: 'Adds the paper to your Zotero library' },
    { state: 'active', verb: 'zotero_export', target: 'references.bib', effect: 'Writes the selected items as BibTeX' },
  ]"
/>

<p class="hero-caption">How the <code>search</code> agent drives the <code>zotero_*</code> tools across one conversation (search → add → export), as the calls appear in the task.</p>

::: tip Default bibliography path
Name your project's main `.bib` file once so agents know where to look up citations: they are told its path, and `extract_bib_entries` also reads it unless the agent names another `.bib` file. The setting key is `texra.bib.defaultPath`; configure it in your `.texra/config.json`.
:::

### <wa-icon library="texra" name="symbol-operator"></wa-icon> Verify math with Wolfram

The `research` agent runs Wolfram Language through `wolframscript` in the shell (`wolframscript -code '...'` or `wolframscript -file`) to check symbolic algebra, integrals, or limits before you commit them to the manuscript. This requires a local [Wolfram Engine](https://www.wolfram.com/engine/); its status shows on its **Wolfram Language** row under **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>).

### <wa-icon library="texra" name="beaker"></wa-icon> Formalize proofs in Lean 4

The `lean` agent formalizes mathematical statements and proofs directly in Lean 4. It searches Mathlib lemmas using Loogle, inspects live proof states and tactic goals, reads compiler diagnostics, and iterates on tactic scripts until the theorem compiles without `sorry`. Read the [Lean 4 proofs guide](./lean.md) for full details.

## Which agent to use

Specialist research agents are tuned for different stages of the work. Pick one from the **Agent** dropdown (<wa-icon library="texra" name="robot"></wa-icon>). `search` ships with TeXRA and needs no sign-in; the built-in `assistant` agent carries the same literature toolset (arXiv, web, Zotero). For computational derivations, reach for `research`; for formal proof verification, use `lean`:

<DropdownMenu
  label="Agent"
  value="search"
  valueIcon="robot"
  maxWidth="320px"
  :groups="[{ label: 'Research & Verification', items: [
    { name: 'search', icon: 'mortar-board', badge: 'chat', badgeVariant: 'info', active: true },
    { name: 'research', icon: 'symbol-operator', badge: 'chat', badgeVariant: 'info' },
    { name: 'lean', icon: 'beaker', badge: 'chat', badgeVariant: 'info' },
  ] }]"
/>

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'mortar-board', title: 'search', desc: 'Finding papers, literature reviews, fact-checking. Built in; the assistant agent has the same tools.', chips: [
      { text: 'arxiv_search', variant: 'neutral' },
      { text: 'web_search', variant: 'neutral' },
      { text: 'web_fetch', variant: 'neutral' },
      { text: 'zotero_search', variant: 'neutral' },
    ] },
    { icon: 'symbol-operator', title: 'research', desc: 'Computational verification with wolframscript in the shell, plus file edits and figure extraction.', chips: [
      { text: 'bash', variant: 'info' },
      { text: 'edit_file', variant: 'neutral' },
      { text: 'extract_figures', variant: 'neutral' },
    ] },
    { icon: 'beaker', title: 'lean', desc: 'Formal proof engineering in Lean 4 and Mathlib with live diagnostic verification.', chips: [
      { text: 'lean_diagnostics', variant: 'info' },
      { text: 'lean_inspect', variant: 'info' },
      { text: 'lean_loogle', variant: 'neutral' },
      { text: 'lean_project', variant: 'neutral' },
    ] },
  ]"
/>

<p class="hero-caption">Each research agent and the tools it has enabled. Check <code>Settings → Agents</code> (<wa-icon library="texra" name="robot"></wa-icon>) for the exact set.</p>

## Next steps

- [Lean 4 proofs](./lean.md): formalize proofs, inspect goal states, and search Mathlib
- [LaTeX tools](./latex-tools.md): formatting, diffs, document statistics, figures, bibliography
- [Agent integrations](./agent-integrations.md): delegate long-running code tasks to Codex or Claude Code
- [Working with figures](./working-with-figures.md): feed figures and PDFs to vision models
