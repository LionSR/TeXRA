# Research Tools

<script setup>
import InquiryFlowHero from '../.vitepress/components/InquiryFlowHero.vue';
import SearchResultsHero from '../.vitepress/components/SearchResultsHero.vue';
import CliSearchChatHero from '../.vitepress/components/CliSearchChatHero.vue';
</script>

You're deep in a manuscript and realise you need to cite "that attention paper from 2017" but can't remember the title. Or you want to verify an integral in your appendix. Or you need to pull twenty BibTeX entries from your Zotero library into a new project. TeXRA's research agents handle all of this without leaving your editor — in VS Code or the `texra` CLI.

<wa-callout variant="brand">
  <wa-icon slot="icon" library="texra" name="shield"></wa-icon>
  Every citation comes from a real <strong>arXiv</strong> or <strong>Crossref</strong> lookup — TeXRA's research agents search grounded sources and never fabricate references.
</wa-callout>

## What You Can Do

### <wa-icon library="texra" name="mortar-board"></wa-icon> Find Papers

Ask a literature-search agent — `search`, `assistant`, `review`, or `presenter` — to find papers. TeXRA queries **arXiv** (preprints) and **Crossref** (published works) automatically:

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

**User story:** A postdoc is writing the related-work section of a NeurIPS submission. She opens the `search` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and asks for papers on "efficient self-attention for long documents." In seconds she has a table of relevant arXiv preprints with titles, authors, and abstracts — ready to cite.

<SearchResultsHero />

<p class="hero-caption">A typical <code>search</code> result set: each preprint carries its title, authors, an arXiv or Crossref source tag, and a one-click <strong>Cite</strong> — every row a real lookup, never fabricated.</p>

The same search streams in a terminal, each lookup surfacing as a tool call
you can watch:

<CliSearchChatHero />

<p class="hero-caption">The postdoc's search in <code>texra chat --agent search</code>: each grounded lookup surfaces as a tool-call row, with results streaming under it.</p>

### <wa-icon library="texra" name="link"></wa-icon> Look Up Citations

Give a DOI or arXiv ID to get full bibliographic details:

```
Get the citation info for arxiv:2401.12345
```

```
Look up DOI 10.1038/nature12373
```

Behind the scenes this calls `arxiv_metadata` or the DOI lookup command in
`crossref_search`.

### <wa-icon library="texra" name="cloud-download"></wa-icon> Download Paper Sources

For deeper analysis, ask to download the LaTeX source of a paper:

```
Download the source files for arxiv:2401.12345 so I can see how they made their figures.
```

This uses the `download_arxiv_source` tool and lands the files in your workspace.

### <wa-icon library="texra" name="globe"></wa-icon> Search the Web

For documentation, project pages, or general info:

```
Find the official PyTorch documentation for attention mechanisms.
```

The `web_search` tool prefers the active provider's native search (Anthropic, OpenAI, Gemini) and falls back to DuckDuckGo Instant Answers. `web_fetch` retrieves a specific URL and extracts its main content.

### <wa-icon library="texra" name="book"></wa-icon> Manage References with Zotero

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library directly. Make sure Zotero is running while you use these features — check status on **Dashboard → Integrations** (<wa-icon library="texra" name="link"></wa-icon>).

```
Search my Zotero library for papers by Vaswani on attention mechanisms.
```

```
Export the selected Zotero items as a .bib file for my project.
```

```
Add this arXiv paper to my Zotero library.
```

**User story:** A PhD student is collecting references for a thesis chapter. She asks the `search` agent to find key papers on graph neural networks, then says "add these to my Zotero and export them to `references.bib`." The agent handles the lookup, adds entries to her Zotero library, and writes the BibTeX file — all in one conversation.

<ToolCallPanel
  title="zotero"
  icon="book"
  :calls="[
    { state: 'done', verb: 'zotero_search', target: 'graph neural networks', effect: 'Finds matching items in your library' },
    { state: 'done', verb: 'zotero_add', target: 'arxiv:2401.12345', effect: 'Adds the paper to your Zotero library' },
    { state: 'active', verb: 'zotero_export', target: 'references.bib', effect: 'Writes the selected items as BibTeX' },
  ]"
/>

<p class="hero-caption">How the <code>search</code> agent drives the <code>zotero_*</code> tools across one conversation — search → add → export — as the calls surface in the Progress view.</p>

::: tip Default Bibliography Path
Set a default location for Zotero exports so agents always know where to save bibliography entries. The setting key is `texra.bib.defaultPath` — configure it in your `.texra/config.json`.
:::

### <wa-icon library="texra" name="symbol-operator"></wa-icon> Verify Math with Wolfram

The `research` agent can call `wolfram` to run Wolfram Language code and check symbolic algebra, integrals, or limits before you commit them to the manuscript. Requires a local [Wolfram Engine](https://www.wolfram.com/engine/); status shows on **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) → **Computation** (<wa-icon library="texra" name="symbol-operator"></wa-icon>).

### <wa-icon library="texra" name="comment-discussion"></wa-icon> External Inquiry

The `inquiry` tool lets a TeXRA agent ask one question in an external chat (ChatGPT, Claude, Gemini) through a copy/paste flow, then resume with the answer. Dispatch is non-blocking: the agent's cycle continues while you fetch the answer, and resumes automatically once you paste it back (even after a reload). No API key required — it uses your existing subscription. In the CLI, the same flow appears as a terminal modal: paste the prepared question into your chat subscription, then paste the answer back into TeXRA.

<InquiryFlowHero />

<p class="hero-caption">The <code>inquiry</code> copy-out / paste-back loop: TeXRA prepares a question, you copy it into ChatGPT, Claude, or Gemini, then paste the reply back to resume the run — no API key needed.</p>

## Which Agent to Use

Two research agents, each tuned for a different stage of the work — pick one from the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>):

<DropdownMenu
  label="Agent"
  value="search"
  valueIcon="sparkle"
  maxWidth="320px"
  :groups="[{ label: 'Research', items: [
    { name: 'search', icon: 'mortar-board', badge: 'tool-use', badgeVariant: 'info', active: true },
    { name: 'research', icon: 'symbol-operator', badge: 'tool-use', badgeVariant: 'info' },
  ] }]"
/>

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'mortar-board', title: 'search', tag: 'default', tagVariant: 'accent', desc: 'Finding papers, literature reviews, fact-checking.', chips: [
      { text: 'arxiv_metadata', variant: 'neutral' },
      { text: 'crossref_search', variant: 'neutral' },
      { text: 'web_search', variant: 'neutral' },
      { text: 'web_fetch', variant: 'neutral' },
      { text: 'zotero', variant: 'neutral' },
    ] },
    { icon: 'symbol-operator', title: 'research', desc: 'Computational verification, plus bash, file edits, and local LaTeX analysis.', chips: [
      { text: 'wolfram', variant: 'info' },
      { text: 'bash', variant: 'neutral' },
      { text: 'file-edit', variant: 'neutral' },
      { text: 'texcount', variant: 'neutral' },
      { text: 'extract_figures', variant: 'neutral' },
    ] },
  ]"
/>

<p class="hero-caption">Each research agent and the tools it has enabled — check <code>Dashboard → Agents</code> (<wa-icon library="texra" name="sparkle"></wa-icon>) for the exact set.</p>

## Next Steps

- [LaTeX Tools](./latex-tools.md) — formatting, diffs, texcount, figures, bibliography
- [Agent Integrations](./agent-integrations.md) — delegate long-running code tasks to Codex or Claude Code
- [Working with Figures](./working-with-figures.md) — feed figures and PDFs to vision models
