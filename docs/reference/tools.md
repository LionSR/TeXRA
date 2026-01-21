# Tool Reference

This page documents all tools available to TeXRA agents. Tools are organized by category for easy navigation.

## Quick Reference

| Category | Tools |
|----------|-------|
| [File Operations](#file-operations) | `read_file`, `write_file`, `edit_file`, `apply_path`, `glob`, `grep`, `ls`, `bash`, `str_replace_editor` |
| [Research & Web](#research-web) | `arxiv_search`, `arxiv_metadata`, `download_arxiv_source`, `crossref_doi`, `crossref_search`, `web_fetch`, `web_search` |
| [LaTeX](#latex) | `extract_figures`, `extract_bib_entries`, `extract_tikz_figures`, `texcount` |
| [Lean 4](#lean-4) | `lean_diagnostics`, `lean_file`, `lean_project`, `lean_inspect`, `lean_loogle` |
| [Utilities](#utilities) | `memory`, `todo_write`, `wolfram`, `diagnostics` |
| [Workflow](#workflow) | `propose_workflow`, `propose_agent`, `runs` |

---

## File Operations

### read_file

Read and return workspace files. Supports text files with optional line ranges, and binary files (PDFs, images) as attachments for vision-capable models.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file to read |
| `range` | object | No | Line range: `{start: number, end?: number}` (1-indexed) |

**Output:** Text content with line numbers, or file attachment for binary files.

```json
{
  "path": "paper.tex",
  "range": {"start": 1, "end": 50}
}
```

---

### write_file

Overwrite a workspace file with provided content. Creates the file if it does not exist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file to write |
| `content` | string | Yes | Content to write to the file |

**Note:** For LaTeX files, automatic text cleanup rules are applied.

```json
{
  "path": "output.tex",
  "content": "\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}"
}
```

---

### edit_file

Perform exact string replacements in workspace files using literal matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file to edit |
| `old_string` | string | Yes | Text to replace (must match exactly) |
| `new_string` | string | Yes | Replacement text |
| `replace_all` | boolean | No | Replace all occurrences (default: false) |

**Note:** `old_string` must be unique in the file unless `replace_all` is true.

```json
{
  "path": "paper.tex",
  "old_string": "Hello World",
  "new_string": "Hello Universe",
  "replace_all": false
}
```

---

### apply_path

Apply a unified diff patch using `git apply`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `patch` | string | Yes | Unified diff patch content |

```json
{
  "patch": "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new"
}
```

---

### glob

Find files matching glob patterns. Returns paths sorted by modification time (most recent first).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g., `**/*.tex`, `src/**/*.ts`) |
| `path` | string | No | Base directory to search in |

```json
{
  "pattern": "**/*.tex",
  "path": "papers"
}
```

---

### grep

Search file contents using regex patterns. Built on ripgrep for performance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | File or directory to search in |
| `glob` | string | No | Glob pattern to filter files (e.g., `*.tex`) |
| `output_mode` | string | No | `content`, `files_with_matches`, or `count` |
| `-B` | number | No | Lines of context before match |
| `-A` | number | No | Lines of context after match |
| `-C` | number | No | Lines of context before and after |
| `-n` | boolean | No | Show line numbers |
| `-i` | boolean | No | Case insensitive search |
| `type` | string | No | File type filter (e.g., `tex`, `py`) |
| `head_limit` | number | No | Limit output to first N results |
| `multiline` | boolean | No | Enable multiline matching |
| `literal` | boolean | No | Treat pattern as literal string |

```json
{
  "pattern": "\\\\cite\\{",
  "path": ".",
  "glob": "*.tex",
  "output_mode": "content",
  "-n": true
}
```

---

### ls

List files and directories with type labels.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to list |
| `ignore` | string[] | No | Glob patterns to ignore |

**Output format:**
```
dir  src/
file README.md
```

```json
{
  "path": ".",
  "ignore": ["node_modules", "*.log"]
}
```

---

### bash

Execute shell commands. Returns stdout on success, throws error with stderr on failure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |

```json
{
  "command": "latexmk -pdf paper.tex"
}
```

---

### str_replace_editor

Anthropic's text editor tool supporting view, create, str_replace, insert, and undo operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | `view`, `create`, `str_replace`, `insert`, or `undo_edit` |
| `path` | string | Yes | Path to file or directory |
| `file_text` | string | No | Content for `create` command |
| `view_range` | number[] | No | Line range `[start, end]` for `view` |
| `old_str` | string | No | Text to find for `str_replace` |
| `new_str` | string | No | Replacement text for `str_replace`/`insert` |
| `insert_line` | number | No | Line number for `insert` (0-indexed) |

**Commands:**

- **view**: View file content or directory listing
- **create**: Create new file (fails if exists)
- **str_replace**: Replace unique string occurrence
- **insert**: Insert text at specific line
- **undo_edit**: Revert last edit

```json
{
  "command": "str_replace",
  "path": "paper.tex",
  "old_str": "\\title{Draft}",
  "new_str": "\\title{Final Version}"
}
```

---

## Research & Web

### arxiv_search

Search arXiv for papers and return basic metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `field` | string | No | Search field: `all`, `author`, `title`, `abstract` |
| `categories` | string[] | No | arXiv category filters (e.g., `cs.AI`, `math.CO`) |
| `maxResults` | number | No | Max results (default: 10, max: 50) |
| `start` | number | No | Pagination offset (default: 0) |
| `sortBy` | string | No | `relevance`, `lastUpdatedDate`, `submittedDate` |
| `sortOrder` | string | No | `ascending`, `descending` |

**Output:** JSON with query info and array of results containing title, authors, abstract, arxivUrl.

```json
{
  "query": "attention mechanism transformer",
  "field": "all",
  "maxResults": 5,
  "categories": ["cs.LG", "cs.CL"]
}
```

---

### arxiv_metadata

Fetch detailed bibliographic metadata for a specific arXiv paper.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | arXiv ID (e.g., `2301.00001` or `hep-th/9901001`) |
| `includeAbstract` | boolean | No | Include abstract (default: true) |
| `maxAuthors` | number | No | Limit author count in response |

**Output:** JSON with id, title, authors, published date, categories, journal reference, links, and optionally abstract.

```json
{
  "id": "2301.00001",
  "includeAbstract": true
}
```

---

### download_arxiv_source

Download arXiv paper source archive into workspace and list extracted files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | arXiv ID |
| `autoIndent` | boolean | No | Auto-format LaTeX files (default: true) |

**Output:** Download path and directory listing.

```json
{
  "id": "2301.00001",
  "autoIndent": true
}
```

---

### crossref_doi

Look up detailed metadata for a DOI using Crossref.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `doi` | string | Yes | DOI string (e.g., `10.1000/xyz123`) |

**Output:** JSON with title, authors, publisher, publication date, abstract, URL, licenses.

```json
{
  "doi": "10.1038/nature12373"
}
```

---

### crossref_search

Search Crossref works and return top matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `rows` | number | No | Max results (default: 10, max: 100) |
| `offset` | number | No | Pagination offset |
| `sort` | string | No | Sort field |
| `order` | string | No | `asc` or `desc` |
| `filter` | string | No | Crossref filter string (e.g., `from-pub-date:2023`) |

**Output:** JSON with results containing title, DOI, publisher, type, issued date, URL.

```json
{
  "query": "machine learning healthcare",
  "rows": 5,
  "filter": "from-pub-date:2020"
}
```

---

### web_fetch

Retrieve HTML from a URL, convert to Markdown, and return cleaned text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch (HTTP/HTTPS only) |
| `prompt` | string | No | Context prompt to prepend to output |

**Notes:**
- Blocks localhost and private network ranges
- Converts HTML/XML to Markdown automatically
- Max content size: 10MB
- Timeout: 30 seconds

```json
{
  "url": "https://arxiv.org/abs/2301.00001",
  "prompt": "Extract the paper abstract and key contributions"
}
```

---

### web_search

Search the web using DuckDuckGo Instant Answers API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `max_results` | number | No | Max results (default: 3, max: 5) |

**Note:** Works best for factual/entity queries. For general searches, try specific terms.

```json
{
  "query": "LaTeX beamer tutorial",
  "max_results": 3
}
```

---

## LaTeX

### extract_figures

Resolve and list figure assets referenced by a LaTeX document, returning image attachments when available.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `texPath` | string | Yes | Path to the primary LaTeX file |

**Output:** List of figure paths with attachments (max 20 files).

```json
{
  "texPath": "paper.tex"
}
```

---

### extract_bib_entries

Collect BibTeX records for citations referenced in a LaTeX document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `texPath` | string | Yes | Path to LaTeX file to scan for citations |
| `bibPath` | string | No | Additional BibTeX file to include |

**Output:** BibTeX entries for cited references (max 25 entries).

```json
{
  "texPath": "paper.tex",
  "bibPath": "extra_refs.bib"
}
```

---

### extract_tikz_figures

Discover TikZ figures in a LaTeX document and optionally compile them into standalone PDFs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `texPath` | string | Yes | Path to LaTeX file containing TikZ figures |
| `compile` | boolean | No | Compile to standalone PDFs (default: true) |

**Output:** List of TikZ figures with compiled PDF attachments (max 12 files).

```json
{
  "texPath": "paper.tex",
  "compile": true
}
```

---

### texcount

Run texcount on one or more LaTeX files for word/character counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | string or string[] | Yes | LaTeX file(s) to analyze |
| `mode` | string | No | `separate` (default), `include`, or `sum` |
| `format` | string | No | `raw` or `stats` |

**Modes:**
- `separate`: Count each file independently
- `include`: Follow `\input`/`\include` commands
- `sum`: Aggregate independent sources

```json
{
  "files": ["chapter1.tex", "chapter2.tex"],
  "mode": "sum",
  "format": "stats"
}
```

---

## Lean 4

All Lean 4 tools require the Lean 4 VS Code extension to be installed and active.

### lean_diagnostics

Get diagnostic messages (errors, warnings, info) for a Lean 4 file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | No | `list` (default) for full messages, `count` for summary |
| `file` | string | Yes | Path to the .lean file |

```json
{
  "command": "list",
  "file": "Mathlib/Analysis/Normed/Group/Basic.lean"
}
```

---

### lean_file

Execute Lean 4 extension commands on a specific file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | `restart` or `refresh_dependencies` |
| `file` | string | Yes | Path to the .lean file |

**Commands:**
- `restart`: Restart Lean server for this file
- `refresh_dependencies`: Refresh file dependencies without full restart

```json
{
  "command": "restart",
  "file": "MyProject/Main.lean"
}
```

---

### lean_project

Execute global Lean 4 extension commands (no file required).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | See available commands below |

**Commands:**

| Command | Description |
|---------|-------------|
| `restart_server` | Restart the entire Lean language server |
| `stop_server` | Stop the Lean language server |
| `build` | Build the project (runs lake build) |
| `clean` | Clean project build artifacts |
| `fetch_cache` | Download Mathlib build cache for project |
| `fetch_file_cache` | Download Mathlib cache for current file's imports |
| `install_elan` | Install Elan (Lean version manager) |
| `install_deps` | Install Lean dependencies |
| `update_elan` | Update Elan to latest version |
| `select_toolchain` | Select default Lean toolchain version |

```json
{
  "command": "fetch_cache"
}
```

---

### lean_inspect

Inspect proof state or type information at a position in a Lean 4 file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | `goal`, `term_goal`, or `hover` |
| `file` | string | Yes | Path to the .lean file |
| `line` | number | Yes | Line number (1-indexed) |
| `column` | number | No | Column number (1-indexed, default: 1) |

**Types:**
- `goal`: Tactic proof state (what needs to be proven)
- `term_goal`: Expected type at cursor in term mode
- `hover`: Type signature and documentation

```json
{
  "type": "goal",
  "file": "MyTheorem.lean",
  "line": 42,
  "column": 5
}
```

---

### lean_loogle

Search for Lean 4 / Mathlib theorems and definitions by type signature or name using the Loogle API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (type signature or name pattern) |
| `limit` | number | No | Max results (default: 10, max: 20) |

**Example queries:**

| Query | Description |
|-------|-------------|
| `Real.sin` | Find lemmas mentioning a constant |
| `List.map` or `"differ"` | Search by name substring |
| `_ * (_ ^ _)` | Find lemmas with subexpression pattern |
| `(?a -> ?b) -> List ?a -> List ?b` | Find List.map by type signature |
| `\|- tsum _ = _ * tsum _` | Search by main conclusion |

**Output:** Name, type signature, module (for imports), and documentation.

```json
{
  "query": "(?a -> ?b) -> List ?a -> List ?b",
  "limit": 5
}
```

---

## Utilities

### memory

Manage persistent memory files under `/memories`. Supports view, create, str_replace, insert, delete, and rename operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Operation to perform |
| `path` | string | Varies | Path starting with `/memories` |
| `file_text` | string | No | Content for `create` |
| `view_range` | number[] | No | Line range `[start, end]` for `view` |
| `old_str` | string | No | Text to find for `str_replace` |
| `new_str` | string | No | Replacement text |
| `insert_line` | number | No | Line number for `insert` (0-indexed) |
| `insert_text` | string | No | Text for `insert` |
| `old_path` | string | No | Source path for `rename` |
| `new_path` | string | No | Destination path for `rename` |

**Commands:**

| Command | Required Parameters | Description |
|---------|---------------------|-------------|
| `view` | `path` | View file or directory listing |
| `create` | `path`, `file_text` | Create new file |
| `str_replace` | `path`, `old_str`, `new_str` | Replace text |
| `insert` | `path`, `insert_line`, `insert_text` | Insert at line |
| `delete` | `path` | Delete file or directory |
| `rename` | `old_path`, `new_path` | Rename/move file |

```json
{
  "command": "create",
  "path": "/memories/project_notes.md",
  "file_text": "# Project Notes\n\n- Key insight: ..."
}
```

---

### todo_write

Create and manage a structured task list for tracking progress on complex tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `todos` | TodoItem[] | Yes | The complete updated todo list |

**TodoItem structure:**

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | Imperative form (e.g., "Run tests") |
| `activeForm` | string | Present continuous form (e.g., "Running tests") |
| `status` | string | `pending`, `in_progress`, or `completed` |

**Best practices:**
- Create todos before starting complex work
- Mark task as `in_progress` before beginning
- Mark as `completed` immediately after finishing
- Keep only ONE task as `in_progress` at a time

```json
{
  "todos": [
    {"content": "Analyze paper structure", "activeForm": "Analyzing paper structure", "status": "completed"},
    {"content": "Fix citations", "activeForm": "Fixing citations", "status": "in_progress"},
    {"content": "Update abstract", "activeForm": "Updating abstract", "status": "pending"}
  ]
}
```

---

### wolfram

Execute Wolfram Language code. Requires WolframScript to be installed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Wolfram Language code to execute |
| `timeout` | number | No | Execution timeout in milliseconds |

```json
{
  "code": "Integrate[Sin[x]^2, {x, 0, Pi}]",
  "timeout": 30000
}
```

---

### diagnostics

Retrieve linter diagnostics (errors, warnings, info) for a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | `list` for full messages, `count` for summary |
| `path` | string | Yes | Path to the file to check |

```json
{
  "command": "list",
  "path": "paper.tex"
}
```

---

## Workflow

### propose_workflow

Propose a workflow agent for document processing. Creates a proposal that requires user approval before execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | Yes | Name of workflow agent |
| `model` | string | No | Model short name (default: `gemini3p`) |
| `instruction` | string | Yes | Plain prose instruction for the agent |
| `inputFile` | string | Yes | Primary input file to process |
| `inputFiles` | string[] | No | Additional input files |
| `referenceFile` | string | No | Reference file (not modified) |
| `referenceFiles` | string[] | No | Additional reference files |
| `auxiliaryFile` | string | No | Auxiliary file (e.g., .bib files) |
| `auxiliaryFiles` | string[] | No | Additional auxiliary files |
| `mediaFile` | string | No | Media file (images/figures) |
| `mediaFiles` | string[] | No | Additional media files |
| `outputFiles` | string[] | No | Output file paths (subset of inputs) |
| `useMultipleOutputs` | boolean | No | Enable multi-file output extraction |

**Available models:** `gemini3p`, `sonnet45`, `opus45`, `gpt45`, `o3`

```json
{
  "agent": "correct",
  "model": "sonnet45",
  "instruction": "Fix grammar errors and improve clarity in this research paper.",
  "inputFile": "paper.tex",
  "auxiliaryFile": "references.bib"
}
```

---

### propose_agent

Propose a tool-use agent for exploration or research tasks. Creates a proposal that requires user approval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | Yes | Name of tool-use agent |
| `model` | string | No | Model short name (default: `gemini3p`) |
| `instruction` | string | Yes | Plain prose instruction with file paths |

```json
{
  "agent": "search",
  "model": "gemini3p",
  "instruction": "Search for recent papers on efficient transformer attention mechanisms to cite in paper.tex"
}
```

---

### runs

View execution history and generated files (read-only).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path starting with `/runs` |
| `view_range` | number[] | No | Line range `[start, end]` for pagination |

**Paths:**

| Path | Description |
|------|-------------|
| `/runs` | List all past executions |
| `/runs/{id}` | Execution summary (agent, model, timestamp) |
| `/runs/{id}/config` | Agent configuration JSON |
| `/runs/{id}/conversation` | Full message history |
| `/runs/{id}/files` | List generated files |
| `/runs/{id}/files/{path}` | Read specific file |

**Note:** Use `current` as `{id}` to access the active execution.

```json
{
  "path": "/runs/current/conversation",
  "view_range": [1, 50]
}
```
