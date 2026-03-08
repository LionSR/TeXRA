# Tool Catalog for Tool-Use Agents

This document lists every tool available to tool-use agents, organized by group.
When creating a tool-use agent, select the tools it needs from these groups.

## File Operations

- `bash` — Execute shell commands in the workspace directory. Use for running scripts, compilation, git, or anything that needs a shell.
- `read_file` — Read workspace files. Supports text files with optional line ranges, PDFs, and images (via vision).
- `write_file` — Overwrite or create a workspace file with provided content.
- `edit_file` — Exact string replacement in files. More surgical than write_file for targeted changes.
- `ls` — List files and directories with optional glob filtering.
- `glob` — Find files matching glob patterns (e.g., `**/*.tex`). Returns paths sorted by modification time.
- `grep` — Search file contents using regex. Supports content, file-matching, and count output modes.

## Web & Search

- `web_search` — Search the web and return top results.
- `web_fetch` — Fetch a URL, convert HTML to Markdown, return cleaned text.

## Academic Research

- `arxiv_search` — Search arXiv for papers. Supports `field="author"` for author searches.
- `arxiv_metadata` — Fetch bibliographic metadata for an arXiv paper by ID.
- `download_arxiv_source` — Download arXiv paper source into the workspace.
- `crossref_search` — Search Crossref works and return top matches.
- `crossref_doi` — Look up detailed metadata for a DOI.

## LaTeX Processing

- `extract_figures` — List and resolve figure assets referenced in a LaTeX document.
- `extract_bib_entries` — Collect BibTeX records for citations in a LaTeX document.
- `extract_tikz_figures` — Discover TikZ figures and optionally compile them to PDF.
- `texcount` — Count words in LaTeX files. Modes: separate, include (follow \input), sum.

## Citation Management

- `zotero_search` — Search Zotero library by key, title, author, or year. Requires Better BibTeX.
- `zotero_add` — Add items to Zotero by DOI, URL, or metadata. Use "preprint" for arXiv papers.
- `zotero_export` — Export BibTeX/BibLaTeX entries from Zotero by citation keys.

## Computation

- `wolfram` — Execute Wolfram Language code. Sessions don't persist between calls.

## Agent Delegation

- `delegate_workflow` — Delegate to a workflow agent for whole-document operations (correct, polish, draw).
- `delegate_agent` — Delegate to another tool-use agent for interactive subtasks.
- `resume_agent` — Send follow-up instructions to a waiting subagent.
- `executions` — View execution history and manage running executions.
- `accept_run_files` — Accept output files from a completed execution.

## Lean 4

- `lean_diagnostics` — Get Lean 4 compiler diagnostics.
- `lean_file` — Read Lean 4 files with semantic info.
- `lean_project` — Manage Lean 4 projects and dependencies.
- `lean_inspect` — Inspect Lean 4 terms and types.
- `lean_loogle` — Search Mathlib by type signature or name.

## Agent Management

- `agent_list` — List files in agent directories (/agents/builtin, /agents/tooluse, /agents/custom, /agents/docs).
- `agent_read` — Read agent YAML files or reference docs from agent directories.
- `agent_write` — Write agent YAML files to the custom agents directory (/agents/custom/).
- `agent_search` — Search agent files for text patterns across agent directories.

## Utility

- `memory` — Manage persistent memory files for cross-session knowledge.
- `todo_write` — Track progress on complex tasks with structured checklists.
- `diagnostics` — Retrieve linter diagnostics for source files.

---

## Recommended Tool Groups by Use Case

When designing a tool-use agent, use these recommended combinations as a starting point.
Most agents should include the File Operations group as a baseline.

**Research agent:**
`bash, read_file, write_file, glob, grep, ls, web_search, web_fetch, arxiv_search, arxiv_metadata, download_arxiv_source, crossref_search, crossref_doi`

**Code/editing agent:**
`bash, read_file, write_file, edit_file, glob, grep, ls, diagnostics`

**LaTeX analysis agent:**
`bash, read_file, write_file, glob, grep, ls, extract_figures, extract_bib_entries, extract_tikz_figures, texcount`

**Literature review agent:**
`bash, read_file, write_file, glob, grep, ls, arxiv_search, arxiv_metadata, crossref_search, crossref_doi, web_search, zotero_search, zotero_add, zotero_export`

**Orchestrator agent:**
`bash, read_file, write_file, glob, grep, ls, delegate_workflow, delegate_agent, resume_agent, executions, accept_run_files, todo_write`

**Computation agent:**
`bash, read_file, write_file, glob, grep, ls, wolfram`

**Lean 4 agent:**
`bash, read_file, write_file, edit_file, glob, grep, ls, lean_diagnostics, lean_file, lean_project, lean_inspect, lean_loogle`

**Minimal chat agent:**
`bash, read_file, write_file, glob, grep, ls`

---

## System Prompt Best Practices for Tool-Use Agents

- Start with a clear role statement: "You are a [role]. Your task is to [objective]."
- Give specific tool usage guidance tailored to the agent's purpose.
- Structure complex workflows as numbered steps.
- Mention tool limitations (e.g., wolfram sessions don't persist, bash cwd is workspace).
- For agents with many tools, organize guidance by phase (discovery → analysis → output).
- Keep prompts focused — only describe what this specific agent needs.
- Use `todo_write` for agents with multi-step verification or audit workflows.
