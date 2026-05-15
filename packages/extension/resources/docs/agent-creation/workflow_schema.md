# Workflow Agent Schema & Reference

Workflow agents process LaTeX documents in a fixed number of rounds (1 or 2),
producing output wrapped in XML tags. Each round uses a chain-of-thought with
`<scratchpad>` planning before the final output.

## YAML structure

```yaml
name: agent_name
description: One-line description.
# inherits: parent_agent   # optional — inherit and override an existing agent

settings:
  agentCategory: workflow
  isRewrite: true # true = editing existing docs, false = creating new
  rounds: 2 # 1 or 2 (default 2)
  temperature: 0.1 # 0.1 for editing, 0.5-0.8 for creative tasks
  documentTag: documents
  endTag: '</documents>'
  prefills: # MUST have exactly `rounds` entries
    - '<scratchpad>'
    - '<scratchpad>'

prompts:
  systemPrompt: |
    [Role, LaTeX conventions, task instructions — use LaTeX formatting like \begin{itemize}]
  userPrefix: |
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>
  userRequest: # MUST be an array with exactly `rounds` entries
    - |
      [Round 1: plan in <scratchpad>, then emit output as <documents><document name="output.tex">...</document></documents>]
    - |
      [Round 2: reflect in <scratchpad>, then emit the refined <documents><document name="output.tex">...</document></documents>]
```

## Critical rules

- `prefills` and `userRequest` MUST both have the same number of entries as
  `rounds`. Round 1 → one entry each; round 2 → two entries each.
- Always include `{{ INSTRUCTION }}` somewhere so user instructions pass
  through.
- System prompts should use LaTeX formatting (`\begin{itemize}`,
  `\textbf{}`, etc.), not Markdown.
- Agent names: lowercase with underscores or dashes. No spaces, no YAML
  special characters.

## Template variables (Nunjucks)

Workflow agent prompts receive:

- `{{ INPUT_FILE }}` — path of the main input file
- `{{ INPUT_CONTENT }}` — full text of the main input file
- `{{ ALL_INPUTS }}` — XML list of all input files (when multiple selected)
- `{{ ALL_CONTEXTS }}` — XML list of context files (.bib/.bbl, reference papers, .sty/.cls)
- `{{ LIST_OF_ALL_CONTEXTS }}` — comma-separated list of context file paths
- `{{ INSTRUCTION }}` — the user's free-text instruction for this run
- `{{ OUTPUT_FILES_ORDER }}` — ordered list of output filenames. Each input
  produces one output of the same name, so most agents simply iterate over
  this list. Only merge-style agents (which write a fresh filename distinct
  from the inputs) need to branch on `{% if OUTPUT_FILES_ORDER %}`. Use
  `{{ OUTPUT_FILES_ORDER[0] }}` for a specific filename and
  `{{ OUTPUT_FILES_ORDER | join(", ") }}` for a human-readable list.

Both categories support `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` blocks
for model-specific instructions.

## Settings guide

- `isRewrite`: true when the agent edits / revises / corrects existing
  documents, false when it creates new content from scratch.
- `temperature`: low (0.1) for editing and correction, higher (0.5–0.8) for
  creative or generative work.
- `rounds`: 1 for single-pass tasks, 2 when reflection materially improves
  the output.

## Multiple-output agents

All workflow agents use the same unified output protocol regardless of whether
they produce one file or many. No separate `_multiple` variant is needed.

- Use `documentTag: documents` (the default). Omit it unless you need a custom
  tag for a legacy single-output agent.
- Add `defaultOutputFiles` with the list of expected filenames when the agent
  produces a fixed set of outputs.
- In `userRequest`, iterate over `OUTPUT_FILES_ORDER` to emit one
  `<document name="filename.tex">` block per output file inside `<documents>`.
  Each input file produces one output of the same name; the runtime always
  populates `OUTPUT_FILES_ORDER` with at least one entry.

Example output format in `userRequest`:

```
<documents>
<document name="{{ OUTPUT_FILES_ORDER[0] }}">
% content for first output
</document>
<document name="{{ OUTPUT_FILES_ORDER[1] }}">
% content for second output
</document>
</documents>
```

## Inheritance

Agents can inherit from existing agents via `inherits: parent_name`. Only the
fields you specify are overridden; everything else comes from the parent.

## Example: the `polish` agent

```yaml
name: polish
description: Improves writing quality and clarity based on your instructions.

settings:
  agentCategory: workflow
  documentTag: documents
  endTag: '</documents>'
  prefills:
    - '<scratchpad>'
    - '<scratchpad>'

prompts:
  systemPrompt: |
    You are a professional scientist. Your task is to improve a LaTeX research
    paper focused solely on the given instructions.

    When writing a \LaTeX document, you must:
    \begin{itemize}
      \item Follow chktex-friendly conventions.
      \item Use consistent notation.
      \item Preserve comments starting with `%'.
      \item Use `` or '' rather than straight quotes.
      \item \textbf{IMPORTANT:} Emit the complete output with all sections in
      original order.
    \end{itemize}

  userPrefix: |
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>

  userRequest:
    - |
      Brainstorm in <scratchpad>, then output the revised LaTeX inside
      <documents><document name="{{ OUTPUT_FILES_ORDER[0] }}">...</document></documents>.
    - |
      Reflect in <scratchpad>, then emit the improved
      <documents><document name="{{ OUTPUT_FILES_ORDER[0] }}">...</document></documents>.
```
