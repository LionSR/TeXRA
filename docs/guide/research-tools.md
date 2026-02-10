# Research Tools

You're deep in a manuscript and realize you need to cite "that attention paper from 2017" but can't remember the exact title. Or you want to verify that an integral in your appendix is correct. Or you need to pull twenty BibTeX entries from your Zotero library into a new project. TeXRA's research agents handle all of this without leaving VS Code.

## What You Can Do

### Find Papers

Ask any research agent to search for papers. TeXRA searches **arXiv** (preprints) and **Crossref** (published works) automatically:

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

**User story:** A postdoc is writing a related-work section for a NeurIPS submission. She opens the `search` agent and asks for papers on "efficient self-attention for long documents." In seconds she has a table of relevant arXiv preprints with titles, authors, and abstracts—ready to cite.

### Look Up Citations

Give a DOI or arXiv ID to get full bibliographic details:

```
Get the citation info for arxiv:2401.12345
```

```
Look up DOI 10.1038/nature12373
```

### Download Paper Sources

For deeper analysis, ask to download the LaTeX source of a paper:

```
Download the source files for arxiv:2401.12345 so I can see how they made their figures.
```

### Search the Web

For documentation, project pages, or general info:

```
Find the official PyTorch documentation for attention mechanisms.
```

### Manage References with Zotero

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library directly. Just make sure Zotero is running when you use these features.

```
Search my Zotero library for papers by Vaswani on attention mechanisms.
```

```
Export the selected Zotero items as a .bib file for my project.
```

```
Add this arXiv paper to my Zotero library.
```

**User story:** A PhD student is collecting references for a thesis chapter. She asks the `search` agent to find key papers on graph neural networks, then says "add these to my Zotero and export them to `references.bib`." The agent handles the lookup, adds entries to her Zotero library, and writes the BibTeX file—all in one conversation.

::: tip Default Bibliography Path
Set `texra.bib.defaultPath` in your VS Code settings to specify where Zotero exports land by default, so agents always know where to save bibliography entries.
:::

## Which Agent to Use

| Agent      | Best for                                                  |
| ---------- | --------------------------------------------------------- |
| `search`   | Finding papers, literature reviews, fact-checking         |
| `research` | Computational verification with Wolfram and literature    |
| `discuss`  | Brainstorming research directions with literature context |
| `ask`      | Quick lookups about your documents and related work       |
