# Tool Catalog for Tool-Use Agents

Every tool available to tool-use agents, organised by group. When designing a
new agent, pick the smallest set of tools that covers its purpose — the
recommended groups at the bottom are a good starting point.

## File operations

- `bash` — execute shell commands in the workspace directory. Use for
  scripts, compilation, git, and anything else that needs a shell.
- `read_file` — read workspace files. Supports text files (with optional
  line ranges), PDFs, and images (as attachments for vision-capable models).
- `write_file` — overwrite or create a workspace file. Writes under the
  allowlisted agent directories go through the normal approval diff; writes
  under read-only directories fail cleanly.
- `edit_file` — exact string replacement in a file. More surgical than
  `write_file` for targeted changes.
- `glob` — find files matching glob patterns (e.g. `**/*.tex`). Returns
  paths sorted by modification time.
- `grep` — search file contents with regex. Supports content,
  files-with-matches, and count output modes.

## Web & search

- `web_search` — search the web and return top results.
- `web_fetch` — fetch a URL, convert HTML to Markdown, return cleaned text.

## Academic research

- `arxiv_search` — search arXiv. Supports `field="author"` for author
  searches.
- `arxiv_metadata` — fetch bibliographic metadata for an arXiv paper by ID.
- `download_arxiv_source` — download an arXiv paper's source archive into
  the workspace.
- `crossref_search` — search Crossref works or look up detailed DOI metadata.

## LaTeX processing

- `extract_figures` — list and resolve figure assets referenced in a LaTeX
  document.
- `extract_bib_entries` — collect BibTeX records for citations.
- `extract_tikz_figures` — discover TikZ figures and optionally compile them
  to PDF.
- `texcount` — count words in LaTeX files.

## Citation management

- `zotero_search`, `zotero_add`, `zotero_export`, `zotero_collections` —
  manage references with Zotero (requires Better BibTeX).

## Computation

- `wolfram` — execute Wolfram Language code. Sessions do NOT persist
  between calls.

## Agent delegation

- `delegate_workflow` — delegate to a workflow agent for whole-document
  operations. Pass `agent`, `model`, `instruction`, `inputFiles`. Returns
  asynchronously via the follow-up queue.
- `delegate_multi_agents` — advanced opt-in tool for a durable sequence of
  workflow-agent calls with predetermined branching and fan-out. Pass a default
  `agent` and exactly one of the complete `script` source or an existing
  `scriptPath`. Submitted source is saved as an
  editable, non-overwriting workspace draft and its path is returned for later
  path-based retries. Optional JSON `args` and role-separated `files` apply in
  either mode. The selected workspace files are fixed for the run and available
  through the immutable `files.inputFiles`, `files.contextFiles`, and
  `files.mediaFiles` arrays. The script begins with an exported `meta` object
  containing `name` and `description`, and can use `agent`, `phase`, `log`,
  `parallel` plus ordinary JavaScript control flow. Workflow-agent calls accept the same
  three file roles. Any call may declare an available model short name with
  `model`; omitted models follow ordinary delegation policy.
  `agent(prompt, { agentName, model, schema })` instead runs a named tool-use
  agent with no file options; it finishes by calling
  `submit_output`, and the call resolves to an envelope whose `.structured`
  contains the validated object. The optional
  `meta.tasks` plan declares `{ id, label, phase? }` records so progress views
  can show pending work before any model call starts. A task phase must name a
  title in `meta.phases`, which accepts either title strings or
  `{ title, detail? }` objects; calls reference the plan with
  `agent(prompt, { id })`. Matching repeated labels or phases are tolerated,
  while conflicts fail. Scripts with a data-dependent call set omit the plan.
  Present in the
  built-in `orchestrator` agent's tool list, but gated by the "Workflow
  Script" switch in Settings → Tools (off by default for new installs), which
  disables the tool for every agent regardless of its configured tool list.
- `delegate_agent` — delegate to another tool-use agent. Pass `agent`,
  `model`, and `instruction` for a fresh run, or `execution_id` +
  `instruction` to resume a WAITING subagent.
- `executions` — view execution history and manage running executions.
- `accept_run_files` — accept output files from a completed execution.

## Lean 4

- `lean_diagnostics`, `lean_file`, `lean_project`, `lean_inspect`,
  `lean_loogle` — Lean 4 proof assistant integration.

## Utility

- `memory` — manage persistent memory files for cross-session knowledge.
- `todo_write` — track progress on complex tasks with structured checklists.
- `plan` — record structured plans.
- `diagnostics` — retrieve linter diagnostics for source files.

## Recommended tool groups by use case

Most agents should include the file-operations set as a baseline.

**Research agent:**
`bash, read_file, write_file, glob, grep, web_search, web_fetch,
arxiv_search, arxiv_metadata, download_arxiv_source, crossref_search`

**Code/editing agent:**
`bash, read_file, write_file, edit_file, glob, grep, diagnostics`

**LaTeX analysis agent:**
`bash, read_file, write_file, glob, grep, extract_figures,
extract_bib_entries, extract_tikz_figures, texcount`

**Literature review agent:**
`bash, read_file, write_file, glob, grep, arxiv_search, arxiv_metadata,
crossref_search, web_search, zotero_search, zotero_add,
zotero_export`

**Orchestrator agent:**
`bash, read_file, write_file, glob, grep, delegate_workflow,
delegate_agent, executions, accept_run_files, todo_write`, optionally
`delegate_multi_agents` for pipelines with a predetermined fan-out/join
structure (off by default — see above).

**Computation agent:**
`bash, read_file, write_file, glob, grep, wolfram`

**Lean 4 agent:**
`bash, read_file, write_file, edit_file, glob, grep, lean_diagnostics,
lean_file, lean_project, lean_inspect, lean_loogle`

**Minimal chat agent:**
`bash, read_file, write_file, glob, grep`

## System prompt best practices

- Start with a clear role: "You are a [role]. Your task is to [objective]."
- Give tool usage guidance tailored to the agent's purpose.
- Structure complex workflows as numbered steps.
- Mention tool limitations (e.g. wolfram sessions don't persist; bash cwd is
  the workspace).
- For agents with many tools, organise guidance by phase (discovery →
  analysis → output).
- Keep prompts focused — describe only what this specific agent needs.
- Use `todo_write` for agents with multi-step verification or audit
  workflows.
