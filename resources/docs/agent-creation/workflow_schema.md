# Workflow Agent Schema & Reference

Workflow agents process LaTeX documents in fixed rounds (1 or 2), producing output
wrapped in XML tags. They use a chain-of-thought workflow with `<scratchpad>`
planning before the final output.

## YAML Structure

```yaml
name: agent_name
description: One-line description
# inherits: parent_agent  # Optional — inherit and override from an existing agent

settings:
  agentCategory: workflow
  isRewrite: true          # true = editing existing docs, false = creating new
  rounds: 2                # 1 or 2 (default 2)
  temperature: 0.1         # 0.1 for editing, 0.5-0.8 for creative
  outputExt: tex           # MUST be "tex" — TeXRA is a LaTeX tool
  documentTag: latex_document
  endTag: "</latex_document>"
  prefills:                # MUST have same number of entries as rounds
    - "<scratchpad>"
    - "<scratchpad>"

prompts:
  systemPrompt: |
    [Role, LaTeX conventions, task instructions — use LaTeX formatting like \begin{itemize}]
  userPrefix: |
    <documents>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>
  userRequest:             # Array — MUST have same number of entries as rounds
    - |
      [Round 1: ask for scratchpad planning, then output in <latex_document> tags]
    - |
      [Round 2: reflection and refinement in scratchpad, then improved output]
```

## Critical Rules

- `outputExt` MUST be `"tex"` (not "md", "txt", or anything else). TeXRA is a LaTeX tool.
- `prefills` and `userRequest` arrays MUST have the same length as `rounds`.
- For rounds: 1 → exactly 1 prefill entry and 1 userRequest entry.
- For rounds: 2 → exactly 2 prefill entries and 2 userRequest entries.
- Always include `{{ INSTRUCTION }}` somewhere in the prompts so the user's instructions pass through.
- System prompts should use LaTeX formatting (`\begin{itemize}`, `\textbf{}`, etc.), not markdown.
- Agent names: lowercase, underscores or dashes, no spaces or special characters.

## Template Variables (Nunjucks)

Available in workflow agent prompts:

- `{{ INPUT_FILE }}` — Path of the main input file
- `{{ INPUT_CONTENT }}` — Full text of the main input file
- `{{ ALL_INPUTS }}` — XML list of all input files (when multiple files selected)
- `{{ ALL_AUXILIARYS }}` — Auxiliary files (preamble.tex, commands.tex, etc.)
- `{{ ALL_REFERENCES }}` — Reference/bibliography files
- `{{ ADDITIONAL_INPUTS }}` — Extra context files
- `{{ INSTRUCTION }}` — User's free-text instruction for this run
- `{{ REFERENCE_CONTENT }}` — Content of reference files
- `{{ AUXILIARY_CONTENT }}` — Content of auxiliary files
- `{{ OUTPUT_FILES_ORDER }}` — Ordered list of output filenames (multiple-output agents only)

Both types support: `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` for model-specific behavior.

## Settings Guide

- `isRewrite`: true when the agent edits/revises/corrects existing documents, false when creating new content.
- `temperature`: low (0.1) for editing/correction tasks, higher (0.5-0.8) for creative/generation tasks.
- `rounds`: 1 for simple single-pass tasks, 2 for tasks that benefit from reflection.

## Multiple Output Agents

For agents producing multiple files, use a separate `_multiple` variant:

- Set `isMultipleOutput: true`, `documentTag: "latex_documents"` (plural), `endTag: "</latex_documents>"`
- Add `defaultOutputFiles` list
- Instruct the model to wrap each file in `<document name="...">` blocks inside `<latex_documents>`
- Name the file `agent_name_multiple.yaml` alongside `agent_name.yaml`

## Inheritance

Agents can inherit from existing agents via `inherits: parent_name` to reuse and override settings/prompts.
Only the fields you specify are overridden; everything else comes from the parent.

## Example: The "polish" Agent

```yaml
name: polish
description: Improves writing quality and clarity based on your specific instructions.
settings:
  agentCategory: workflow
  documentTag: latex_document
  endTag: </latex_document>
  outputExt: tex
  prefills:
    - <scratchpad>
    - <scratchpad>
prompts:
  systemPrompt: |
    You are a professional scientist. Your task is to improve a LaTeX research paper
    focusing solely on addressing the given instructions.
    When writing a professional *.tex \LaTeX document, you must:
    \begin{itemize}
        \item Follow chktex-friendly conventions.
        \item Use appropriate notation consistently.
        \item Preserve comments starting with `%'.
        \item Use `` or '' rather than straight quotes.
        \item \textbf{IMPORTANT:} Give complete output with all sections in original order.
    \end{itemize}
  userPrefix: |
    <documents>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>
  userRequest:
    - |
      Brainstorm in <scratchpad>, then output revised \LaTeX in <latex_document> tags.
    - |
      Reflect on changes in <scratchpad>, then output improved <latex_document>.
```
