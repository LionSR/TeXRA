# Document Task Schema & Reference

An agent file with a `task` block is also a document task. Its persona
(`prompt`, `temperature`) is an ordinary agent; the `task` block says how a
document task runs it over files. The task makes a fixed sequence of
revisions, one per entry in `task.requests` (usually 1 or 2). Each revision
calls the persona once, extracts the documents from its reply, compiles and
diffs them; the last revision's documents are proposed for the user to
accept. Each revision uses a chain-of-thought with `<scratchpad>` planning
before the final output.

The persona reads the documents only through the revision prompt: `prefix`,
then each earlier request with its reply, then this revision's request.

## YAML structure

```yaml
name: agent_name
description: One-line description.
temperature: 0.1 # 0.1 for editing, 0.5-0.8 for creative tasks

prompt: |
  [Role, LaTeX conventions, task instructions — use LaTeX formatting like \begin{itemize}]

task:
  rewrite: true # true = editing existing docs (default), false = creating new
  prefix: |
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>
  requests: # one revision per entry, in order
    - |
      [Revision 1: plan in <scratchpad>, then emit output as <documents><document name="output.tex">...</document></documents>]
    - |
      [Revision 2: reflect in <scratchpad>, then emit the refined <documents><document name="output.tex">...</document></documents>]
```

The file is flat: `name`, `description`, `temperature` and
`prompt` sit at the top level, and the `task` block holds `rewrite`,
`outputs`, `files`, `prefix` and `requests`. Unknown keys are refused, and
there is no reader for the old nested `settings:` / `prompts:` format.

## Critical rules

- `task.requests` needs at least one entry. The number of entries is the
  number of revisions; there is no separate revision count.
- A `task` file cannot declare `tools`: a document task works text-only.
- Always include `{{ INSTRUCTION }}` somewhere in `prefix` or `requests` so
  user instructions pass through.
- System prompts should use LaTeX formatting (`\begin{itemize}`,
  `\textbf{}`, etc.), not Markdown.
- Agent names: lowercase with underscores or dashes. No spaces, no YAML
  special characters.

## Template variables (Nunjucks)

`task.prefix` and each `task.requests` entry receive the variables below.
The persona `prompt` does not: it is the system prompt of every revision's
call, rendered without the task's files.

- `{{ INPUT_FILE }}` — path of the main input file
- `{{ INPUT_CONTENT }}` — full text of the main input file
- `{{ ALL_INPUTS }}` — XML list of all input files (when multiple selected)
- `{{ ALL_CONTEXTS }}` — XML list of context files (.bib/.bbl, reference papers, .sty/.cls)
- `{{ LIST_OF_ALL_CONTEXTS }}` — comma-separated list of context file paths
- `{{ INSTRUCTION }}` — the user's free-text instruction for this run
- `{{ INPUT_FILES }}` — ordered list of input filenames. Editing agents should
  output one document for each input, preserving the same names and order. Use
  `{{ INPUT_FILES | default([], true) | join(", ") }}` for a human-readable list
  (guards against null/absent `INPUT_FILES` so the prompt renders safely).
- `{{ OUTPUT_FILES }}` — ordered list of declared generated filenames. This is
  only populated when the launch names output files or the agent declares
  `task.outputs`.
- `{{ X_FILE }}` and `{{ X_CONTENT }}` — for each `task.files` binding
  `X: some_file.tex`, the path and text of that file, which lives beside the
  agent YAML.

The `prompt` of any agent supports `{% if IS_ANTHROPIC_MODEL %}...{% endif %}` blocks
for model-specific instructions. It is the only model gate: there is no
variable for any other provider, and an invented one renders as false.

## Settings guide

- `task.rewrite`: true (the default) when the agent edits / revises /
  corrects existing documents, which are diffed against the inputs; false
  when it creates new content from scratch.
- `temperature`: optional, 0 to 1, default 1.0. Low (0.1) for editing and
  correction, higher (0.5–0.8) for creative or generative work.
- `task.requests`: one entry for single-pass tasks, two when reflection
  materially improves the output.

## Multiple-output agents

All document tasks use the same unified output protocol regardless of whether
they produce one file or many. No separate `_multiple` variant is needed.

- The `<documents><document name="...">` container is fixed protocol, not a
  setting — every agent emits it; there is nothing to configure.
- For editing agents, iterate over `INPUT_FILES` to emit one
  `<document name="filename.tex">` block per selected input file inside
  `<documents>`.
- Add `task.outputs` only when the agent produces generated files with
  fixed names distinct from the inputs. Those names are exposed as
  `OUTPUT_FILES`.

Example output format in a `task.requests` entry:

```
<documents>
{% for output in INPUT_FILES %}
<document name="{{ output }}">
% content for {{ output }}
</document>
{% endfor %}
</documents>
```

## Example: a `polish` agent

```yaml
name: polish
description: Improves writing quality and clarity based on your instructions.

prompt: |
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

task:
  prefix: |
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>
    <instruction>{{ INSTRUCTION }}</instruction>

  requests:
    - |
      Brainstorm in <scratchpad>, then output the revised LaTeX inside
      <documents>
      {% for output in INPUT_FILES %}
      <document name="{{ output }}">...</document>
      {% endfor %}
      </documents>.
    - |
      Reflect in <scratchpad>, then emit the improved
      <documents>
      {% for output in INPUT_FILES %}
      <document name="{{ output }}">...</document>
      {% endfor %}
      </documents>.
```
