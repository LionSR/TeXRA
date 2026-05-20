# Research Tools

You're deep in a manuscript and realise you need to cite "that attention paper from 2017" but can't remember the title. Or you want to verify an integral in your appendix. Or you need to pull twenty BibTeX entries from your Zotero library into a new project. TeXRA's research agents handle all of this without leaving VS Code.

## What You Can Do

### <wa-icon library="texra" name="mortar-board"></wa-icon> Find Papers

Ask any research agent to search for papers. TeXRA queries **arXiv** (preprints) and **Crossref** (published works) automatically:

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

**User story:** A postdoc is writing the related-work section of a NeurIPS submission. She opens the `search` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and asks for papers on "efficient self-attention for long documents." In seconds she has a table of relevant arXiv preprints with titles, authors, and abstracts — ready to cite.

### <wa-icon library="texra" name="link"></wa-icon> Look Up Citations

Give a DOI or arXiv ID to get full bibliographic details:

```
Get the citation info for arxiv:2401.12345
```

```
Look up DOI 10.1038/nature12373
```

Behind the scenes this calls the `arxiv_metadata` and `crossref_doi` tools.

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

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library directly. Make sure Zotero is running while you use these features — check status on **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) → **Academic Research** (<wa-icon library="texra" name="mortar-board"></wa-icon>).

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

::: tip Default Bibliography Path
Set `texra.bib.defaultPath` in your VS Code settings (<wa-icon library="texra" name="gear"></wa-icon>) to specify where Zotero exports land by default, so agents always know where to save bibliography entries.
:::

### <wa-icon library="texra" name="symbol-operator"></wa-icon> Verify Math with Wolfram

The `research` agent can call `wolfram` to run Wolfram Language code and check symbolic algebra, integrals, or limits before you commit them to the manuscript. Requires a local [Wolfram Engine](https://www.wolfram.com/engine/); status shows on **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) → **Computation** (<wa-icon library="texra" name="symbol-operator"></wa-icon>).

### <wa-icon library="texra" name="comment-discussion"></wa-icon> External Inquiry

The `inquiry` tool lets a TeXRA agent ask one question in an external chat (ChatGPT, Claude, Gemini) through a copy/paste flow, then resume with the answer. Dispatch is non-blocking: the agent's cycle continues while you fetch the answer, and resumes automatically once you paste it back (even after a reload). No API key required — it uses your existing subscription. In the CLI, the same flow appears as a terminal modal: paste the prepared question into your chat subscription, then paste the answer back into TeXRA.

## Which Agent to Use

| Agent      | Best for                                                       |
| ---------- | -------------------------------------------------------------- |
| `search`   | Finding papers, literature reviews, fact-checking              |
| `research` | Computational verification with Wolfram and literature lookups |
| `discuss`  | Brainstorming research directions with literature context      |
| `ask`      | Quick lookups about your documents and related work            |

Pick any of them from the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>). Check `Dashboard → Agents` (<wa-icon library="texra" name="sparkle"></wa-icon>) to see exactly which tools each one has enabled.

## Next Steps

- [LaTeX Tools](./latex-tools.md) — formatting, diffs, texcount, figures, bibliography
- [Codex CLI](./codex-cli.md) — delegate long-running code tasks to OpenAI Codex
- [Working with Figures](./working-with-figures.md) — feed figures and PDFs to vision models
