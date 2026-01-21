# Research Tools

TeXRA provides a suite of research tools that enable AI agents to search, discover, and retrieve academic content. These tools are essential for literature reviews, citation management, and research workflows that require accessing external sources.

This guide covers how to use each research tool effectively for academic research tasks.

## Overview

| Tool | Purpose | Best For |
|------|---------|----------|
| `arxiv_search` | Search arXiv papers | Finding preprints by topic, author, or category |
| `arxiv_metadata` | Get paper metadata | Retrieving details for known arXiv IDs |
| `download_arxiv_source` | Download LaTeX source | Analyzing paper structure, extracting figures |
| `crossref_doi` | Lookup DOI metadata | Getting complete bibliographic data |
| `crossref_search` | Search published works | Finding peer-reviewed publications |
| `web_fetch` | Fetch webpage content | Reading documentation, project pages |
| `web_search` | Search the web | Quick factual lookups, finding resources |

## arXiv Tools

arXiv is a cornerstone of academic preprint distribution. TeXRA provides three tools for interacting with the arXiv repository.

### arxiv_search

Search for papers on arXiv using flexible query options.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search terms |
| `field` | enum | No | `"all"` | Search field: `"all"`, `"author"`, `"title"`, `"abstract"` |
| `categories` | string[] | No | - | Filter by arXiv categories (e.g., `["cs.AI", "math.CO"]`) |
| `maxResults` | integer | No | 10 | Number of results (1-50) |
| `start` | integer | No | 0 | Offset for pagination |
| `sortBy` | enum | No | - | Sort by: `"relevance"`, `"lastUpdatedDate"`, `"submittedDate"` |
| `sortOrder` | enum | No | - | Order: `"ascending"`, `"descending"` |

**Returns:** JSON with search results containing:
- `id` - arXiv identifier (e.g., `"2401.12345"`)
- `doi` - DOI if available
- `title` - Paper title
- `published` / `updated` - Date timestamps
- `authors` - List of author names
- `primaryCategory` - Primary arXiv category
- `abstract` - Paper abstract
- `arxivUrl` - Direct link to arXiv abstract page

**Example: Search by Topic**

```json
{
  "name": "arxiv_search",
  "arguments": {
    "query": "transformer attention mechanisms",
    "categories": ["cs.LG", "cs.CL"],
    "maxResults": 5,
    "sortBy": "submittedDate",
    "sortOrder": "descending"
  }
}
```

**Example: Search by Author**

```json
{
  "name": "arxiv_search",
  "arguments": {
    "query": "Yoshua Bengio",
    "field": "author",
    "maxResults": 10
  }
}
```

**Example: Search for Exact Phrase**

Use double quotes within the query to search for exact phrases:

```json
{
  "name": "arxiv_search",
  "arguments": {
    "query": "\"neural radiance fields\"",
    "field": "title",
    "maxResults": 20
  }
}
```

### arxiv_metadata

Retrieve detailed metadata for a specific arXiv paper when you know its identifier.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | - | arXiv identifier (e.g., `"2401.12345"`, `"arxiv:2401.12345"`, or full URL) |
| `includeAbstract` | boolean | No | `true` | Include the paper abstract |
| `maxAuthors` | integer | No | - | Limit number of authors returned (1-50) |

**Returns:** JSON with complete paper metadata:
- `id`, `doi`, `title`, `published`, `updated`, `authors`, `primaryCategory` (same as search)
- `journalReference` - Published journal reference if available
- `comment` - Author comments (often contains page count, conference info)
- `links` - Related links (PDF, DOI, etc.)
- `abstract` - Paper abstract (if `includeAbstract` is true)

**Example: Get Paper Details**

```json
{
  "name": "arxiv_metadata",
  "arguments": {
    "id": "2401.12345"
  }
}
```

**Example: Get Metadata from URL**

The tool automatically extracts IDs from various formats:

```json
{
  "name": "arxiv_metadata",
  "arguments": {
    "id": "https://arxiv.org/abs/2401.12345"
  }
}
```

```json
{
  "name": "arxiv_metadata",
  "arguments": {
    "id": "https://arxiv.org/pdf/2401.12345.pdf"
  }
}
```

### download_arxiv_source

Download the LaTeX source files for an arXiv paper into your workspace. This is useful for analyzing paper structure, extracting figures, or understanding how complex documents are organized.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | - | arXiv identifier |
| `autoIndent` | boolean | No | `true` | Automatically format LaTeX files with proper indentation |

**Returns:** Summary message with the download path and a directory listing of extracted files.

**Example: Download Paper Source**

```json
{
  "name": "download_arxiv_source",
  "arguments": {
    "id": "2401.12345"
  }
}
```

**What Gets Downloaded:**
- `.tex` files (main document and includes)
- `.bib` bibliography files
- Figures (PDF, PNG, EPS, etc.)
- Style files and custom macros
- Supporting materials

**Common Use Cases:**
1. Extract TikZ figure code from papers
2. Study document structure for similar papers
3. Reuse bibliography entries
4. Analyze LaTeX macro patterns

## Crossref Tools

Crossref provides metadata for published scholarly works with DOIs. Use these tools for peer-reviewed publications.

### crossref_doi

Look up detailed metadata for a specific DOI.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `doi` | string | Yes | - | The DOI to look up (e.g., `"10.1038/nature12373"`) |

**Returns:** JSON with complete bibliographic metadata:
- `doi` - The DOI
- `title` - Work title
- `titles` - All title variants
- `publisher` - Publishing entity
- `type` - Work type (e.g., `"journal-article"`, `"book-chapter"`)
- `abstract` - Abstract if available
- `created` / `published` - Date information
- `url` - Primary resource URL
- `language` - Content language
- `authors` - Author list with affiliations
- `licenses` - License information

**Example: Look Up a DOI**

```json
{
  "name": "crossref_doi",
  "arguments": {
    "doi": "10.1038/nature12373"
  }
}
```

### crossref_search

Search the Crossref database for published works.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search terms |
| `rows` | integer | No | 10 | Number of results (1-100) |
| `offset` | integer | No | - | Offset for pagination |
| `sort` | string | No | - | Sort field (e.g., `"relevance"`, `"published"`, `"score"`) |
| `order` | enum | No | - | Sort order: `"asc"`, `"desc"` |
| `filter` | string | No | - | Crossref filter string |

**Returns:** JSON with search results:
- `query` - The search query
- `count` - Number of results returned
- `totalResults` - Total matching works
- `results` - Array of works with `title`, `doi`, `publisher`, `type`, `issued`, `url`

**Example: Search Published Works**

```json
{
  "name": "crossref_search",
  "arguments": {
    "query": "machine learning drug discovery",
    "rows": 15,
    "sort": "published",
    "order": "desc"
  }
}
```

**Example: Filter by Date**

Use Crossref filter syntax to narrow results:

```json
{
  "name": "crossref_search",
  "arguments": {
    "query": "quantum computing",
    "filter": "from-pub-date:2023,has-orcid:true"
  }
}
```

**Common Filters:**
- `from-pub-date:YYYY` - Published after year
- `until-pub-date:YYYY` - Published before year
- `has-abstract:true` - Only works with abstracts
- `has-orcid:true` - Authors with ORCID
- `type:journal-article` - Specific work type

## Web Tools

General-purpose tools for accessing web content.

### web_fetch

Retrieve content from a URL and convert it to Markdown for processing.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Absolute URL (HTTP/HTTPS) |
| `prompt` | string | No | - | Context for interpreting the content |

**Returns:** The webpage content converted to Markdown, with the optional prompt context prepended.

**Example: Fetch Documentation**

```json
{
  "name": "web_fetch",
  "arguments": {
    "url": "https://docs.python.org/3/library/asyncio.html",
    "prompt": "Extract the main concepts and key functions for async programming"
  }
}
```

**Example: Read a Project Page**

```json
{
  "name": "web_fetch",
  "arguments": {
    "url": "https://github.com/huggingface/transformers"
  }
}
```

**Limitations:**
- Maximum content size: 10 MB
- Timeout: 30 seconds
- Private/local network addresses are blocked for security
- JavaScript-rendered content may not be captured

### web_search

Perform a web search using DuckDuckGo's Instant Answers API.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search terms |
| `max_results` | integer | No | 3 | Maximum results (1-5) |

**Returns:** Search results with summaries and URLs.

**Example: Quick Factual Lookup**

```json
{
  "name": "web_search",
  "arguments": {
    "query": "Python dataclass decorator",
    "max_results": 3
  }
}
```

**Best Practices:**
- This API works best for factual/entity queries
- Use specific, focused queries for better results
- Combine with `web_fetch` to get full content from search results

## Research Workflows

### Literature Review Workflow

A typical workflow for conducting a literature review:

1. **Discover relevant papers** using `arxiv_search` or `crossref_search`
2. **Get detailed metadata** with `arxiv_metadata` or `crossref_doi`
3. **Download sources** with `download_arxiv_source` for key papers
4. **Extract figures and structure** using TeXRA's LaTeX tools

**Example Conversation:**

> "Find recent papers on graph neural networks for molecular property prediction, then get the full metadata for the top 3 results."

The agent might execute:

```json
{
  "name": "arxiv_search",
  "arguments": {
    "query": "graph neural networks molecular property prediction",
    "categories": ["cs.LG", "q-bio.BM"],
    "maxResults": 3,
    "sortBy": "submittedDate",
    "sortOrder": "descending"
  }
}
```

Followed by `arxiv_metadata` calls for each result.

### Citation Enrichment Workflow

When you have DOIs and need complete bibliographic data:

1. **Extract DOIs** from your document or references
2. **Look up each DOI** with `crossref_doi`
3. **Format citations** using the retrieved metadata

### Source Code Analysis Workflow

For analyzing how other papers structure their LaTeX:

1. **Find relevant papers** with `arxiv_search`
2. **Download the source** with `download_arxiv_source`
3. **Use file tools** (`read_file`, `glob`, `grep`) to explore the structure
4. **Extract specific elements** like TikZ figures or bibliography entries

## API Rate Limits

To respect API providers and ensure reliable operation, TeXRA implements rate limiting:

| API | Rate Limit |
|-----|------------|
| arXiv | ~1 request per 3 seconds |
| Crossref | ~1 request per second |

The tools handle rate limiting automatically. If you're making many requests, expect some delay between calls.

## Tips for Effective Research

### Combining Tools

Chain tools together for comprehensive research:

1. Search arXiv for initial discovery
2. Cross-reference with Crossref for published versions
3. Use web tools for supplementary materials

### Query Optimization

- **Be specific**: "transformer attention mechanism vision" is better than "deep learning"
- **Use field filters**: Search by `author` or `title` when you have partial information
- **Leverage categories**: Filter by arXiv categories to reduce noise
- **Date sorting**: Use `submittedDate` or `lastUpdatedDate` for recent work

### Handling Results

- Check both arXiv and Crossref for the same work (preprint vs. published)
- Use DOIs for stable, citeable references
- Download sources for papers you'll reference heavily

## Error Handling

Common error scenarios and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "No metadata found for arXiv ID" | Invalid or non-existent ID | Verify the ID format and existence |
| "Crossref lookup failed" | Invalid DOI or network issue | Check DOI format, retry later |
| "Failed to download arXiv source" | No source available | Not all papers have source files |
| "Network error fetching URL" | Connectivity issue | Check network, retry later |

## Next Steps

Now that you understand the research tools, explore:

- [LaTeX Tools](./latex-tools.md) - LaTeX-specific tools and workflows
- [Best Practices](./best-practices.md) - Optimize your research workflow
- [Custom Agents](./custom-agents.md) - Build agents that use these tools
