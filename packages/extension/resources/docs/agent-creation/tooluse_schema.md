# Tool-Use Agent Schema & Reference

Tool-use agents are interactive, multi-turn conversational agents with tool
calling. They access files ONLY through their declared tools (`read_file`,
`write_file`, `bash`, `grep`, etc.) — no pre-loaded content. The only
template variable they receive is `{{ INSTRUCTION }}`.

## YAML structure

```yaml
name: agent_name
description: One-line description.

settings:
  agentCategory: toolUse
  temperature: 0.7 # 0.3-0.5 for precise tasks, 0.7-0.8 for creative
  tools:
    - bash
    - read_file
    - write_file
    - glob
    - grep

prompts:
  systemPrompt: |
    [Role, behaviour, tool usage guidance]
  userRequest: |
    {{ INSTRUCTION }}
```

## Critical rules

- `agentCategory` MUST be `"toolUse"` (not `"workflow"`).
- `userRequest` MUST be a single string (not an array) and MUST contain
  `{{ INSTRUCTION }}`.
- Do NOT use `userPrefix` — tool-use agents do not receive pre-loaded file
  content.
- The ONLY template variable is `{{ INSTRUCTION }}`. Do not use any
  workflow-only variables (`INPUT_FILE`, `INPUT_CONTENT`, `ALL_INPUTS`,
  `ALL_CONTEXTS`, `INPUT_FILES`, `OUTPUT_FILES`).
- `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` works for model-specific
  instructions.
- Agent names: lowercase with underscores or dashes.

## Choosing tools

Pick only the tools the agent needs. See `tool_catalog.md` in this directory
for the full registry and recommended tool groups by use case. Most agents
want at least `read_file`, `write_file`, `glob`, and `grep`; add
`bash` when the agent must run commands.

## Example: the `research` agent

```yaml
name: research
description: Searches academic literature and synthesises findings.

settings:
  agentCategory: toolUse
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
    - arxiv_metadata
    - download_arxiv_source
    - crossref_search

prompts:
  systemPrompt: |
    You are a research assistant. Search academic literature, download
    relevant papers, and synthesise findings for the user.

    Use arxiv_search and crossref_search to find candidates.
    Use arxiv_metadata or crossref_search with the doi command for detailed bibliographic data.
    Use download_arxiv_source to fetch full paper sources.
    Use web_search and web_fetch for broader context.
    Use read_file and write_file to work with documents in the workspace.

  userRequest: |
    {{ INSTRUCTION }}
```
