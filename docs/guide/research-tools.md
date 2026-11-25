# Research tools

<script setup>
import SearchResultsHero from '../.vitepress/components/SearchResultsHero.vue';
import CliSearchChatHero from '../.vitepress/components/CliSearchChatHero.vue';
</script>

TeXRA's assistant reaches arXiv, Zotero, DuckDuckGo, WolframScript, and Lean 4 so you can search literature, manage BibTeX references, and check symbolic or formal math from your workspace.

<wa-callout variant="brand">
  <wa-icon slot="icon" library="texra" name="shield"></wa-icon>
  Every citation comes from a real <strong>arXiv</strong> lookup or your <strong>Zotero</strong> library. TeXRA searches grounded sources and never fabricates references.
</wa-callout>

## What you can do

### <wa-icon library="texra" name="mortar-board"></wa-icon> Find papers

Ask the assistant to find papers. It searches **arXiv** through arXiv's public API, the web, and your Zotero library:

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

<SearchResultsHero />

<p class="hero-caption">A typical search result set: each preprint carries its title, authors, and an arXiv source tag. Every row is a real lookup, never fabricated.</p>

The same search streams in a terminal, with each lookup shown as a tool call:

<CliSearchChatHero />

<p class="hero-caption">A search in <code>texra chat</code>: each grounded lookup surfaces as a tool-call row, with results streaming under it.</p>

### <wa-icon library="texra" name="cloud-download"></wa-icon> Download paper sources

For deeper analysis, ask to download the LaTeX source of a paper:

```
Download the source files for arxiv:2401.12345 so I can see how they made their figures.
```

The assistant fetches the source archive from arXiv with a shell command and unpacks it under `References/<paper id>/` in your workspace.

### <wa-icon library="texra" name="globe"></wa-icon> Search the web

For documentation, project pages, or general information:

```
Find the official PyTorch documentation for attention mechanisms.
```

The `web_search` tool queries the DuckDuckGo Instant Answers API, not a model provider's hosted search. `web_fetch` retrieves a specific URL and returns the page as clean text.

### <wa-icon library="texra" name="book"></wa-icon> Manage references with Zotero

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library. The assistant talks to the local server Zotero runs on port 23119 with shell commands, as its bundled `zotero` skill describes; keep Zotero running while you use these features, and turn skills on (below).

```
Search my Zotero library for papers on attention mechanisms.
```

```
Export the selected Zotero items as a .bib file for my project.
```

```
Add this arXiv paper to my Zotero library.
```

Each request to Zotero is a `bash` call you approve like any other shell command.

::: tip Turn skills on
How to query arXiv and Zotero is written down in two bundled skills, `arxiv` and `zotero`. The assistant reads them only while **Enable skills for agents** is on (**Settings → Agents → Skills**, or `texra.skills.enabled`).
:::

::: tip Default bibliography path
Name your project's main `.bib` file once so the assistant knows where to look up citations: it is told its path and searches it with `grep` or `read_file`. The setting key is `texra.bib.defaultPath`; configure it in your `.texra/config.json`.
:::

### <wa-icon library="texra" name="symbol-operator"></wa-icon> Verify math with Wolfram

The assistant runs Wolfram Language through `wolframscript` in the shell (`wolframscript -code '...'` or `wolframscript -file`) to check symbolic algebra, integrals, or limits before you commit them to the manuscript. This requires a local [Wolfram Engine](https://www.wolfram.com/engine/); its status shows on its **Wolfram Language** row under **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>).

### <wa-icon library="texra" name="beaker"></wa-icon> Formalize proofs in Lean 4

The assistant formalizes mathematical statements and proofs directly in Lean 4. It searches Mathlib lemmas using Loogle, inspects live proof states and tactic goals, reads compiler diagnostics, and iterates on tactic scripts until the theorem compiles without `sorry`. Read the [Lean 4 proofs guide](./lean.md) for full details.

## Programs

You ask the assistant for any of this directly: a literature search, a
derivation checked with `wolframscript`, an audit of a manuscript, work on a
research-level problem. For Lean, the `prove` program completes proofs until
Lean reports no error and no `sorry`.

Read [The assistant and programs](./programs.md) for the full list.

## Next steps

- [Lean 4 proofs](./lean.md): formalize proofs, inspect goal states, and search Mathlib
- [LaTeX tools](./latex-tools.md): formatting, diffs, document statistics, figures, bibliography
- [Agent integrations](./agent-integrations.md): hand code tasks to Codex or Claude Code, follow GitHub activity, MCP servers
- [Working with figures](./working-with-figures.md): feed figures and PDFs to vision models
