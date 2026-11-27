---
name: arxiv
description: Search arXiv for papers and download a paper's LaTeX source, with `curl` against arXiv's public endpoints. Use to find papers by topic, title or author, to confirm a paper's metadata, or to read a paper's own equations and source instead of a summary of it.
---

# arXiv: search and source download

Both jobs are plain HTTPS requests; run them with `bash` and `curl` (or `web_fetch` for the search).

## Search

```bash
curl -sG 'https://export.arxiv.org/api/query' \
  --data-urlencode 'search_query=ti:"tensor network" AND au:vidal AND cat:quant-ph' \
  --data-urlencode 'start=0' \
  --data-urlencode 'max_results=10' \
  --data-urlencode 'sortBy=relevance' \
  --data-urlencode 'sortOrder=descending'
```

- `search_query` joins terms with `AND` (also `OR`, `ANDNOT`). Prefix each term with its field: `all:` (every field), `ti:` (title), `au:` (author), `abs:` (abstract), `cat:` (category). Quote a phrase.
- Categories are spelled exactly as in https://arxiv.org/category_taxonomy, case included: `math.NT`, `cs.AI`, `cond-mat.str-el`, `quant-ph`, `hep-th`. A misspelled category matches nothing; it does not fail.
- `start` is the zero-based offset for paging, `max_results` the page size (keep it at 50 or below).
- `sortBy` is `relevance`, `lastUpdatedDate` or `submittedDate`; `sortOrder` is `ascending` or `descending`.
- A known paper is fetched by id: `id_list=2404.12175` in place of `search_query`.
- Wait 3 seconds between requests, as arXiv asks; do not send them in parallel.

The reply is an Atom feed. Each `<entry>` carries `<id>` (`http://arxiv.org/abs/<id>v<n>`; the id is what follows `/abs/`, without the version), `<title>`, `<summary>` (the abstract), one `<author><name>` per author, `<published>`, `<updated>`, `<arxiv:primary_category term="...">` and, when the paper has one, `<arxiv:doi>`. `<opensearch:totalResults>` is the total count. Cite a paper from these fields, never from memory.

## Download a paper's source

```bash
id=2404.12175                      # old-style ids contain a slash: hep-th/9901001
dir="References/${id//\//_}"
mkdir -p "$dir" && curl -sSL --max-time 120 -o "$dir/source" "https://arxiv.org/src/$id"
file "$dir/source"
```

Skip the download when the directory already holds the source. What arrived decides the next step:

- a gzip-compressed tar archive (the usual case): `tar -xzf "$dir/source" -C "$dir" && rm "$dir/source"`;
- gzip data that is not a tar archive (a single TeX file): `gunzip -c "$dir/source" > "$dir/main.tex" && rm "$dir/source"`;
- a PDF: the submission has no LaTeX source. Remove the directory and say so; read the PDF from `https://arxiv.org/pdf/<id>` only if the user wants that.

Put the source under `References/<id>/` unless the user asks for it elsewhere, and never unpack over existing project files. List the extracted files and find the main file (`grep -l '\\documentclass' "$dir"/*.tex`) before reading. A 404 means the id is wrong; a 5xx or a timeout is worth one or two retries a few seconds apart.
