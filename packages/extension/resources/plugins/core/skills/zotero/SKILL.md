---
name: zotero
description: Search the user's Zotero library, export BibTeX or BibLaTeX entries from it, list its collections and add items to it, with `curl` against Zotero's local HTTP server. Use when the user keeps references in Zotero and asks to cite, export or save a paper. Needs Zotero running; search and export need its Better BibTeX plugin.
---

# Zotero: search, export, collections, add

The Zotero desktop app serves a local HTTP API while it runs, on port 23119 of `127.0.0.1`. Two parts share that port:

- **Better BibTeX JSON-RPC** at `/better-bibtex/json-rpc`: search, export and collections. It exists only when the Better BibTeX plugin (https://retorque.re/zotero-better-bibtex/) is installed.
- **Connector API** at `/connector/*`: adding items. It is part of Zotero itself.

Neither needs a key. Call them with `bash` and `curl`; `web_fetch` does not reach the local machine. If the user changed Zotero's port (the `extensions.zotero.httpServer.port` preference in Zotero's Config Editor), use that port instead.

When citing, prefer an entry already in the library over newly written BibTeX, and check its metadata against the source.

## Check that it is reachable

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 http://127.0.0.1:23119/connector/ping
```

- No connection: Zotero is not running. Ask the user to start it; do not retry in a loop.
- `200` here but `404` from `/better-bibtex/json-rpc`: Better BibTeX is not installed. Adding still works; search and export do not.

## Better BibTeX calls

Every call is a JSON-RPC POST; the answer is in `.result`, or `.error.message` when it failed.

```bash
bbt() {  # bbt <method> <params as a JSON array>
  curl -s --max-time 30 http://127.0.0.1:23119/better-bibtex/json-rpc \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2,\"id\":1}"
}
```

**Search** (`item.search`). The first parameter is either a quick-search string or a list of conditions:

```bash
bbt item.search '["vidal entanglement"]'
bbt item.search '[[["title","contains","renormalization"],["creator","contains","Vidal"],["date","is","2007"]]]'
```

- A quick-search string matches title, creators and year at once, and every word must match: keep it to one or two terms, such as a surname or a citation key.
- Conditions are `[field, operator, value]`. Use a few distinctive title words, not the full title, and a single surname for `creator`.
- A second parameter names the library to search (`"*"` for all); without it the search covers My Library.
- Each result is CSL JSON with a `citekey`. The title is `title`, the authors `author` (`family`, `given`), the year `issued["date-parts"][0][0]`, the type `type`.

**Collections of items** (`item.collections`): `bbt item.collections '[["citekey1","citekey2"],true]'` maps each citation key to its collections; with `true`, each `parentCollection` is the nested parent, so the chain reads as a path.

**All collections** (`user.groups`): `bbt user.groups '[true]'` lists every library (`id`, `name`) with its `collections` (`key`, `name`, `parentCollection`: the parent's key, or `false` at the top level).

**Export** (`item.export`): `bbt item.export '[["citekey1","citekey2"],"biblatex"]'` returns the entries as one string. The format is `biblatex`, `bibtex` or `json`; a third parameter names the library. An empty result means no entry has those keys. Write the entries into the project's `.bib` file yourself, without duplicating a key already there.

## Add items (Connector API)

Before adding, search the library and the project's `.bib` files for the title or DOI, so nothing is added twice. A write to the user's library is theirs to approve: say what you will add.

With metadata, one item per request:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 30 \
  http://127.0.0.1:23119/connector/saveItems \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"itemType":"preprint","title":"...","creators":[{"firstName":"Given","lastName":"Family","creatorType":"author"}],"date":"2024","abstractNote":"...","url":"https://arxiv.org/abs/2404.12175"}]}'
```

- `itemType` is one of `journalArticle`, `book`, `bookSection`, `conferencePaper`, `thesis`, `report`, `webpage`, `preprint`. An arXiv paper or any other preprint is `preprint`, never `webpage`.
- Other fields: `publicationTitle` (the journal), `volume`, `issue`, `pages`.
- A person is `{"firstName","lastName","creatorType":"author"}`, with a name particle ("van der") in `lastName`; an organization is `{"name","creatorType":"author"}`.
- Add `"targetID":"<collection key>"` beside `items` to file the item in a collection.

With only a URL, let Zotero read the page's metadata: POST `{"url":"https://..."}` (and `targetID` if wanted) to `/connector/saveSnapshot`. A snapshot takes no metadata, so use `saveItems` whenever you have any.

`200` or `201` means the item was saved; any other status carries an `error` in its JSON body. Do not interrupt or blindly repeat a save that timed out: check the library first, since the item may have landed. Take the metadata from the source (the arXiv record, the DOI's publisher page), not from memory.
