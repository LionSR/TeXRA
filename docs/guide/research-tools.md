# Research Tools

The `search`, `discuss`, and `ask` agents can find academic papers and web content for you. Just describe what you're looking for.

## What You Can Do

### Find Papers

Ask any research agent to search for papers:

```
Find recent papers on transformer architectures for document understanding.
Focus on work from 2023-2024 that handles mathematical equations.
```

The agent searches **arXiv** (preprints) and **Crossref** (published works) automatically.

### Look Up Citations

Give a DOI or arXiv ID to get full bibliographic details:

```
Get the citation info for arxiv:2401.12345
```

```
Look up DOI 10.1038/nature12373
```

### Download Paper Sources

For deeper analysis, ask to download the LaTeX source:

```
Download the source files for arxiv:2401.12345 so I can see how they made their figures.
```

### Search the Web

For documentation, project pages, or general info:

```
Find the official PyTorch documentation for attention mechanisms.
```

### Manage References with Zotero

If you use [Zotero](https://www.zotero.org/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin, TeXRA can search, export, and add items to your library directly:

```
Search my Zotero library for papers by Vaswani on attention mechanisms.
```

```
Export the selected Zotero items as a .bib file for my project.
```

```
Add this arXiv paper to my Zotero library.
```

The Zotero tools (`zotero_search`, `zotero_export`, `zotero_add`) communicate with Better BibTeX's JSON-RPC interface. Make sure Zotero is running with Better BibTeX installed when using these tools.

::: tip Default Bibliography Path
Set `texra.bib.defaultPath` in your VS Code settings to specify the default `.bib` file for Zotero exports, so agents know where to save bibliography entries.
:::

## Which Agent to Use

| Agent      | Best for                                                  |
| ---------- | --------------------------------------------------------- |
| `search`   | Finding papers, literature reviews, fact-checking         |
| `research` | Computational verification with Wolfram and literature    |
| `discuss`  | Brainstorming research directions with literature context |
| `ask`      | Quick lookups about your documents and related work       |
