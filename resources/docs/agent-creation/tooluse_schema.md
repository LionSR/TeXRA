# Tool-Use Agent Schema & Reference

Tool-use agents are interactive, multi-turn conversation agents with tool calling.
They access files ONLY through tools (read_file, write_file, bash, grep, etc.) — no pre-loaded content.
They only receive `{{ INSTRUCTION }}` as a template variable.

## YAML Structure

```yaml
name: agent_name
description: One-line description

settings:
  agentCategory: toolUse
  temperature: 0.7          # 0.3-0.5 for precise tasks, 0.7-0.8 for creative
  tools:
    - bash
    - read_file
    - write_file
    - glob
    - grep
    - ls

prompts:
  systemPrompt: |
    [Role, behavior, tool usage guidance]
  userRequest: |
    {{ INSTRUCTION }}
```

## Critical Rules

- `agentCategory` MUST be `"toolUse"` (not "workflow").
- `userRequest` MUST be a single string (not an array), and MUST contain `{{ INSTRUCTION }}`.
- Do NOT use `userPrefix` — tool-use agents don't receive pre-loaded file content.
- The ONLY template variable is `{{ INSTRUCTION }}` (the user's free-text request).
- Do NOT use any workflow-only variables: INPUT_FILE, INPUT_CONTENT, ALL_INPUTS,
  ALL_AUXILIARYS, ALL_REFERENCES, ADDITIONAL_INPUTS, REFERENCE_CONTENT,
  AUXILIARY_CONTENT, OUTPUT_FILES_ORDER.
- Use `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` for model-specific instructions.
- Agent names: lowercase, underscores or dashes, no spaces or special characters.

## Choosing Tools

Select only the tools the agent needs. See `tool_catalog.md` in this directory
for the complete list of available tools with descriptions and recommended
combinations by use case.

## Example: The "research" Agent

```yaml
name: research
description: Searches academic literature and synthesizes findings.
settings:
  agentCategory: toolUse
  temperature: 0.7
  tools:
    - bash
    - read_file
    - write_file
    - glob
    - grep
    - ls
    - web_search
    - web_fetch
    - arxiv_search
    - arxiv_metadata
    - download_arxiv_source
    - crossref_search
    - crossref_doi
prompts:
  systemPrompt: |
    You are a research assistant. Your task is to search academic literature,
    download and analyze papers, and synthesize findings for the user.

    Use arxiv_search and crossref_search to find relevant papers.
    Use arxiv_metadata and crossref_doi for detailed metadata.
    Use download_arxiv_source to get full paper sources.
    Use web_search and web_fetch for broader information.
    Use read_file and write_file to work with documents in the workspace.
  userRequest: |
    {{ INSTRUCTION }}
```
