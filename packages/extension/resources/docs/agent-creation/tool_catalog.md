# Tool Catalog for Agents

Every tool an agent can declare in `tools`, organised by group. When designing a
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
- `open_pdf` — open a PDF file in the host PDF viewer. Accepts
  workspace-relative paths, working-directory-relative paths, and absolute
  run-storage paths.

## Web & search

- `web_search` — search the web and return top results.
- `web_fetch` — fetch a URL, convert HTML to Markdown, return cleaned text.

## Academic research

- `arxiv_search` — search arXiv. Supports `field="author"` for author
  searches.
- `download_arxiv_source` — download an arXiv paper's source archive into
  the workspace.

## LaTeX processing

- `extract_figures` — list and resolve figure assets referenced in a LaTeX
  document.
- `extract_bib_entries` — collect BibTeX records for citations.
- `extract_tikz_figures` — discover TikZ figures and optionally compile them
  to PDF.

## Citation management

- `zotero_search`, `zotero_add`, `zotero_export`, `zotero_collections` —
  manage references with Zotero (requires Better BibTeX).

## Agent delegation

- `agent` — run a named agent as a child of this run, with a prompt. Pass
  `prompt` and `agentName`; the agent works with its own tools and may take
  `schema` (a JSON Schema object; its value returns as `structured`),
  `mediaFiles` and `working_directory`. Gated by the "Multi-Agent Workflow"
  switch in Settings → Plugins, which removes it from every agent when off.
- `document_task` — run a named agent's document task over files, as a
  child of this run. Pass `agentName`, `inputFiles` (rewritten, one revised
  document each) plus optional `prompt`, `contextFiles`, `mediaFiles`,
  `outputFiles`, `extractFigures`, and `extractTikz`. Only an agent with a
  `task` block has a document task. Unlike `agent`, it is not gated by the
  "Multi-Agent Workflow" switch.
- Both take `model` (with an `@effort` suffix), `memories`, `label`, and
  `timeoutMs`. Called directly, the child runs in the background and its
  result arrives as a follow-up message (a one-shot run waits).
- `script` — run a JavaScript program that calls the agent's other tools.
  `code` is the body of an async function: `await tools.<name>(args)` or
  `await agent(prompt, opts)`, `await document_task(prompt, opts)`,
  `Promise.all` / `Promise.allSettled`, `try`/`catch`, `phase(title)`, and
  `console.log`. In a script, `agent()` waits for the child and resolves to
  `{ response, files, structured?, runId, outcome, cost }` (`document_task()`
  to `{ documents: { outputs }, runId, outcome, cost }`), or rejects
  with an Error named `AgentFailed`, `TimedOut`, `Skipped`,
  `ModelUnavailable`, `CallLimit`, or `DuplicateCall`; give otherwise
  identical calls distinct `id`s. One approval request covers every `agent`
  and `document_task` call in the script and shows its source. There are no timers, no
  `Date.now()`, no `Math.random()`, and no imports, so an interrupted script
  replays exactly and finished calls are not run again. `run_in_background:
true` runs it as its own background run that delivers one result and a
  summary as a follow-up; `timeoutMs` is the wall clock (1 s to 24 h,
  default 60 min). Use it when the whole fan-out and join is known up front;
  call `agent` directly when the next step depends on reading the last
  result.
- `executions` — view execution history and manage running executions;
  `action: "send"` on `/executions/<id>` messages another run, such as a
  follow-up to a WAITING subagent.
- `accept_run_files` — accept output files from a completed execution, such
  as the documents a document task proposed.

## External coding agents

- `codex` — spin off an OpenAI Codex coding agent in its own sandbox
  (separate CLI process, `sandbox_mode`-controlled). Async and multi-turn
  like an `agent` call; requires the Codex CLI and `codex login` (or
  `OPENAI_API_KEY`).
- `claude_code` — spin off a separate Claude Code agent via the Claude Agent
  SDK, with independent file editing, search, and shell access in its own
  workspace (permission-mode controlled, not sandboxed). Async and
  multi-turn like an `agent` call; requires the Claude Code CLI and an
  Anthropic API key or OAuth session. `codex` and `claude_code` are both
  independent external coders distinct from the in-process `agent`
  specialists — for parallel or isolated edits, run them against a git
  worktree.

## Lean 4

- `lean_diagnostics`, `lean_file`, `lean_project`, `lean_inspect`,
  `lean_loogle` — Lean 4 proof assistant integration.

## GitHub

- `github_subscription` — subscribe to GitHub activity (PR/issue comments,
  reviews, inline review comments, failed CI checks, check annotations,
  merge-conflict transitions) for the current run; follow-ups arrive as
  `<github-webhook-activity>` messages.

## Code review (VS Code only)

- `inline_comment` — leave resolvable inline comment threads in the editor
  via VS Code's native Comments UI (gutter bubbles + Comments panel). Not
  available on the CLI or desktop hosts.

## Utility

- `memory` — manage persistent memory files for cross-session knowledge.
- `plan` — record structured plans.
- `diagnostics` — retrieve linter diagnostics for source files.
- `ask_user_question` — ask the user one to three short clarification
  questions and wait for their answers, when continuing without their
  preference would be guesswork.
- `inquiry` — dispatch a question to an external AI model via the user as a
  human-in-the-loop bridge; the run continues (even after a restart, even
  hours later) once the user pastes the answer back.

## Recommended tool groups by use case

Most agents should include the file-operations set as a baseline.

**Research agent:**
`bash, read_file, write_file, glob, grep, web_search, web_fetch,
arxiv_search, download_arxiv_source`

**Code/editing agent:**
`bash, read_file, write_file, edit_file, glob, grep, diagnostics`

**LaTeX analysis agent:**
`bash, read_file, write_file, glob, grep, extract_figures,
extract_bib_entries, extract_tikz_figures`

**Literature review agent:**
`bash, read_file, write_file, glob, grep, arxiv_search, web_search,
zotero_search, zotero_add, zotero_export`

**Orchestrator agent:**
`bash, read_file, write_file, glob, grep, agent, document_task, script,
executions, accept_run_files`. `agent` needs the "Multi-Agent Workflow"
switch on (see above).

**Computation agent:**
`bash, read_file, write_file, glob, grep` (Wolfram Language runs through
`wolframscript` in bash)

**Lean 4 agent:**
`bash, read_file, write_file, edit_file, glob, grep, lean_diagnostics,
lean_file, lean_project, lean_inspect, lean_loogle`

**Minimal chat agent:**
`bash, read_file, write_file, glob, grep`

## System prompt best practices

- Start with a clear role: "You are a [role]. Your task is to [objective]."
- Give tool usage guidance tailored to the agent's purpose.
- Structure complex workflows as numbered steps.
- Mention tool limitations (e.g. bash cwd is the workspace).
- For agents with many tools, organise guidance by phase (discovery →
  analysis → output).
- Keep prompts focused — describe only what this specific agent needs.
