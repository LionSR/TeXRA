# Tool-Use Agent Schema & Reference

Tool-use agents are interactive, multi-turn conversational agents with tool
calling. They access files ONLY through their declared tools (`read_file`,
`write_file`, `bash`, `grep`, etc.) — no pre-loaded content. The user's
instruction arrives as the user message, not through a template variable.

## YAML structure

```yaml
name: agent_name
description: One-line description.
temperature: 0.7 # 0.3-0.5 for precise tasks, 0.7-0.8 for creative
tools:
  - bash
  - read_file
  - write_file
  - glob
  - grep

prompt: |
  [Role, behaviour, tool usage guidance]
```

The file is flat: `name`, `description`, `inherits`, `temperature`, `tools`
and `prompt` sit at the top level. Unknown keys are refused, and there is no
reader for the old nested `settings:` / `prompts:` format.

## Critical rules

- A tool-use (chat) agent has no `task` block. A file with `task` is a
  document task (see `workflow_schema.md`) and cannot declare `tools`.
- There is no request template: the user's instruction is sent as the user
  message. Do not add a field for it.
- `prompt` is the system prompt. Do not use any workflow-only variables
  (`INPUT_FILE`, `INPUT_CONTENT`, `ALL_INPUTS`, `ALL_CONTEXTS`,
  `INPUT_FILES`, `OUTPUT_FILES`).
- `temperature` is optional, between 0 and 1, and defaults to 1.0. There is
  no `model` field; the model is chosen at launch.
- `tools` is optional. An agent with no tools works text-only.
- `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` works for model-specific
  instructions. It is the only model gate: there is no variable for any other
  provider, and an invented one renders as false. It is rendered once, for
  the model the chat starts on; TeXRA's own model-specific guidance follows
  a model switch on its own, so an agent rarely needs it.
- Agent names: lowercase with underscores or dashes.

## Choosing tools

Pick only the tools the agent needs. See `tool_catalog.md` in this directory
for the full registry and recommended tool groups by use case. Most agents
want at least `read_file`, `write_file`, `glob`, and `grep`; add
`bash` when the agent must run commands.

## Example: a `literature` agent

```yaml
name: literature
description: Searches academic literature and synthesises findings.
temperature: 0.7
tools:
  - bash
  - read_file
  - write_file
  - glob
  - grep
  - web_search
  - web_fetch
  - arxiv_search
  - download_arxiv_source

prompt: |
  You are a research assistant. Search academic literature, download
  relevant papers, and synthesise findings for the user.

  Use arxiv_search to find candidates; each hit carries its abstract and
  bibliographic data.
  Use download_arxiv_source to fetch full paper sources.
  Use web_search and web_fetch for broader context.
  Use read_file and write_file to work with documents in the workspace.
```
