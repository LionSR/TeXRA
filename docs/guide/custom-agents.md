# Custom Agents

TeXRA is a VS Code extension that orchestrates AI-driven writing tools using YAML agent files. TeXRA supports two agent categories:

- **Workflow agents** (`agentType: CoT` or `direct`) follow a structured chain-of-thought workflow with optional scratchpad planning and XML-wrapped output.
- **Tool-use agents** (`agentType: toolUse`) run interactive sessions with tool-calling capabilities for file operations, web searches, and more.

This guide focuses on creating agent definition (`.yaml`) files so you can tailor TeXRA to your research needs.

::: info Agent Fundamentals
Before creating a custom agent, it is recommended to understand the underlying concepts:

- **Agent Architecture & Execution Flow**: Learn about the `.yaml` structure, settings, prompts, and how agents run. See the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- **Built-in Agents**: Review the standard agents provided by TeXRA for examples and potential inheritance parents. See the [Built-in Agent Reference](./built-in-agents.md).
- **Agent Explorer**: Learn how to browse and manage agent files using the [Agent Explorer](./agent-explorer.md) view in the TeXRA sidebar.
:::

## Creating a Custom Agent File

Follow these steps to create a new custom agent:

### Step 1: Locate or Configure the Custom Agents Directory

Custom agents reside in a dedicated directory that TeXRA prepares for you.

1.  **Find the Default Folder**: TeXRA automatically seeds a `custom_agents` directory inside its global storage. Look for the "Custom Agents" section in the [Agent Explorer](./agent-explorer.md); it points to this location by default.
2.  **Override (Optional)**: If you prefer to manage agents elsewhere, set an absolute path in VS Code Settings (`Ctrl+,`) under `texra.explorer.agentsDirectory`. TeXRA will ensure that directory exists and use it instead of the default.

### Automatic Creation

If you'd like TeXRA to draft an agent for you, use the **Create AI Agent** <i class="codicon codicon-sparkle"></i> button in the Agent Explorer title bar. The wizard only asks for a short description and the default output filenames. TeXRA sends this information to a Claude model, which replies with the YAML enclosed in `<yaml>...</yaml>` tags. The extension extracts the content between those tags and saves it as a basic CoT template (single or multiple files) in your Custom Agents folder.

### Step 2: Create a New YAML File

1.  Using the [Agent Explorer](./agent-explorer.md), right-click within your "Custom Agents" directory (or a subfolder).
2.  Select "New File".
3.  You'll be prompted for a name. Choose a descriptive name using underscores and ending with `.yaml` (e.g., `literature_review_generator.yaml`).

### Step 3: Define the Agent

Open the newly created `.yaml` file and you will find a starter template already inserted. Customize it to define your agent's structure. The following sections provide detailed schemas and examples for both workflow and tool-use agents.

## Agent Definition Schema

Every agent YAML file has the following top-level structure:

```yaml
name: my_agent           # Required: Unique identifier for the agent
description: |           # Optional: Human-readable description
  Short description of what this agent does.
inherits: polish         # Optional: Inherit from another agent
settings:                # Required: Agent behavior configuration
  # ... (see below)
prompts:                 # Required: LLM instruction templates
  # ... (see below)
```

### The `inherits` Field

Use `inherits` to extend an existing built-in or custom agent. When you inherit from an agent, you receive all its settings and prompts, then override only what you need to change. This is useful for creating specialized variants.

**Available built-in agents for inheritance:**

- **Workflow agents**: `polish`, `correct`, `merge`, `draw`, `ocr`, `transcribe_audio`
- **Tool-use agents**: `ask`, `chat`, `research`, `discuss`, `search`

Example:

```yaml
name: formal_polish
inherits: polish
settings:
  temperature: 0.0  # Override temperature for more deterministic output
prompts:
  systemPrompt: |
    You are a formal academic editor...  # Override the system prompt
```

## Creating Workflow Agents

Workflow agents process documents through structured rounds with optional reflection. They produce XML-wrapped output that TeXRA extracts and saves.

### Agent Types

**CoT (Chain-of-Thought)**: Multi-round reflection with iterative refinement.

- Default: 2+ rounds (max of configured rounds and userRequest length)
- Always enforces XML structure for reasoning
- Best for: Complex tasks requiring step-by-step reasoning and revision

**Direct**: Single-pass execution with minimal overhead.

- Default: 1 round (single-pass processing)
- Best for: Simple corrections, quick transformations, merge operations

### Workflow Settings Schema

```yaml
settings:
  # Core behavior
  agentType: CoT          # 'CoT' or 'direct' for workflow agents
  temperature: 0.1        # 0.0 = deterministic, up to 1.0 = more random
  isRewrite: true         # true for rewriting content, false for generating new

  # Output handling
  documentTag: latex_document     # XML tag wrapping the output
  endTag: '</latex_document>'     # Closing tag signaling completion
  outputExt: tex                  # File extension (tex, md, txt, etc.)

  # Response prefills (what the AI starts with)
  prefills:
    - '<scratchpad>'      # Prefill for Round 0
    - '<scratchpad>'      # Prefill for Round 1 (reflection)

  # Advanced: Multiple output support
  isMultipleOutput: false         # Set true for multi-file output
  defaultOutputFiles:             # Default filenames for multiple outputs
    - introduction.tex
    - methods.tex

  # Advanced: Override default behavior
  rounds: 2               # Number of reflection rounds
  maxRounds: 3            # Maximum rounds (overrides default calculation)
  xmlStructureMode: always  # 'never', 'scratchpadOnly', or 'always'

  # File handling (optional)
  requiredFiles:
    TEMPLATE: templates/main.tex  # Workspace-relative paths
  requiredFilesInternal:
    STYLE: styles/custom.sty      # Paths relative to agent YAML location
  filePatternsContain:
    - pattern: 'commands'
      varName: COMMANDS
      categories: ['auxiliaryFile']
```

### Workflow Prompts Schema

```yaml
prompts:
  systemPrompt: |
    # Defines the AI's role, persona, and constraints.
    # Sent once at the beginning of the conversation.
    You are a professional scientist...

  userPrefix: |
    # Provides context: input files, references, and instructions.
    # Template variables are substituted here.
    Here is the document to revise:
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>

    <instruction>{{ INSTRUCTION }}</instruction>

  userRequest:
    - |
      # Round 0: Initial task prompt
      Please revise the document...
      <scratchpad>
      [Plan your changes here]
      </scratchpad>
      <latex_document>
      [Your revised document]
      </latex_document>
    - |
      # Round 1+: Reflection prompts
      Reflect on your changes and improve further...
```

> **Reflection Tips:** When `userRequest` is an array, TeXRA takes the first
> entry as the initial request and treats the remaining entries as reflection
> prompts. If a run requests more reflections than the list provides, the first
> reflection template is reused.

### Example: Direct Agent (Single-Pass)

```yaml
name: quick_correct
description: Fast single-pass correction for typos and grammar.

settings:
  agentType: direct
  documentTag: latex_document
  endTag: '</latex_document>'
  outputExt: tex
  prefills:
    - 'Here is the corrected document. <latex_document>'

prompts:
  systemPrompt: |
    You are a LaTeX proofreader. Fix typos, grammar, and formatting issues.

  userPrefix: |
    Please correct this document:
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>

    {% if INSTRUCTION %}
    Additional instructions: {{ INSTRUCTION }}
    {% endif %}

  userRequest: |
    Correct all typos and grammatical errors.
    Output the corrected document:
    <latex_document>
    % Corrected document here
    </latex_document>
```

### Example: CoT Agent (Multi-Round with Reflection)

```yaml
name: deep_polish
description: Multi-round polishing with detailed planning and reflection.

settings:
  agentType: CoT
  documentTag: latex_document
  endTag: '</latex_document>'
  outputExt: tex
  rounds: 2
  prefills:
    - '<scratchpad>'
    - '<scratchpad>'

prompts:
  systemPrompt: |
    You are a professional scientific editor. Improve clarity and rigor.

  userPrefix: |
    Here is the document to improve:
    <documents>
    {{ ALL_AUXILIARYS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>

    Instruction: {{ INSTRUCTION }}

  userRequest:
    - |
      Plan your improvements in the scratchpad, then output the revised document.
      <scratchpad>
      1. [Improvement 1]
      2. [Improvement 2]
      </scratchpad>
      <latex_document>
      % Revised document
      </latex_document>
    - |
      Reflect on your changes. Did you fully address the instruction?
      <scratchpad>
      Reflection: [What could be improved?]
      </scratchpad>
      <latex_document>
      % Further improved document
      </latex_document>
```

## Creating Tool-Use Agents

Tool-use agents run interactive sessions where the AI can call tools to read files, execute commands, search the web, and more. They continue until the task is complete or the user intervenes.

### Tool-Use Settings Schema

```yaml
settings:
  agentType: toolUse      # Required: must be 'toolUse'
  tools:                  # Required: list of tool names to enable
    - read_file
    - write_file
    - glob
    - grep
    - ls
    - bash
```

### Available Tools

**File Operations:**

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (returns first 2,000 lines with optional range) |
| `write_file` | Write content to a file |
| `edit_file` | Apply targeted edits to a file |
| `str_replace_editor` | String replacement editor for precise edits |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with ripgrep |
| `ls` | List directory contents |
| `bash` | Execute shell commands |

**LaTeX Tools:**

| Tool | Description |
|------|-------------|
| `extract_figures` | Extract figure assets from LaTeX documents |
| `extract_bib_entries` | Extract BibTeX entries for cited references |
| `extract_tikz_figures` | Compile TikZ diagrams to images |
| `texcount` | Count words in LaTeX documents |

**Research Tools:**

| Tool | Description |
|------|-------------|
| `arxiv_search` | Search arXiv for papers |
| `arxiv_metadata` | Get metadata for an arXiv paper |
| `download_arxiv_source` | Download arXiv paper source |
| `crossref_search` | Search Crossref for publications |
| `crossref_doi` | Get metadata by DOI |
| `web_search` | Search the web |
| `web_fetch` | Fetch and process web page content |

**Computation Tools:**

| Tool | Description |
|------|-------------|
| `wolfram` | Execute Wolfram Language code |

**Utility Tools:**

| Tool | Description |
|------|-------------|
| `todo_write` | Track task progress with a todo list |
| `memory` | Persist notes across sessions |
| `diagnostics` | Get editor diagnostics for a file |

**Lean 4 Tools:**

| Tool | Description |
|------|-------------|
| `lean_diagnostics` | Get Lean 4 diagnostics |
| `lean_file` | Read Lean 4 file with semantic info |
| `lean_project` | Explore Lean 4 project structure |
| `lean_inspect` | Inspect Lean 4 definitions |
| `lean_loogle` | Search Mathlib with Loogle |

### Tool-Use Prompts Schema

```yaml
prompts:
  systemPrompt: |
    # Define the AI's role and tool usage guidelines.
    You are a research assistant...

  userRequest: |
    # The user's instruction is inserted here.
    {{ INSTRUCTION }}
```

> **Note:** Tool-use agents typically do not use `userPrefix` since context is
> gathered dynamically through tool calls. The `{{ INSTRUCTION }}` variable
> provides the user's request.

### Example: Read-Only Assistant

```yaml
name: ask
description: Read-only assistant for answering questions about documents.

settings:
  agentType: toolUse
  tools:
    - read_file
    - glob
    - grep
    - ls
    - extract_figures
    - extract_bib_entries

prompts:
  systemPrompt: |
    You are a scientist. Reason deeply.

    You answer questions by inspecting the workspace. You may read files
    and run search commands, but you must not modify files.

    When answering:
    (1) Use $...$ for inline math and \begin{aligned} ... \end{aligned}
        for multi-step derivations.

  userRequest: |
    {{ INSTRUCTION }}
```

### Example: Full-Featured Research Agent

```yaml
name: research
description: Research assistant with file editing and computation tools.

settings:
  agentType: toolUse
  tools:
    - wolfram
    - todo_write
    - bash
    - read_file
    - write_file
    - edit_file
    - glob
    - grep
    - ls
    - extract_figures
    - extract_bib_entries
    - arxiv_search
    - arxiv_metadata
    - crossref_search
    - crossref_doi

prompts:
  systemPrompt: |
    You are a computational research assistant specializing in analytical
    derivations and numerical programming. You have access to the Wolfram
    Language for symbolic mathematics.

    Wolfram Language Guidelines:
    (1) Use the wolfram tool for computations.
    (2) Verify symbolic results by substituting test values.
    (3) Convert results to LaTeX using TeXForm when appropriate.

    File Operations:
    (1) Read files first to understand context before editing.
    (2) Use edit_file for targeted changes, write_file for new content.

    Task Management:
    (1) Use todo_write to track multi-step derivations.
    (2) Mark each step complete after verification.

  userRequest: |
    {{ INSTRUCTION }}
```

### Example: Web Search Agent

```yaml
name: web_research
description: Research assistant with web search and literature discovery.

settings:
  agentType: toolUse
  tools:
    - read_file
    - glob
    - grep
    - ls
    - arxiv_search
    - arxiv_metadata
    - crossref_search
    - crossref_doi
    - web_search
    - web_fetch

prompts:
  systemPrompt: |
    You are a research assistant helping discover and synthesize information
    from the web and academic literature.

    Research Workflow:
    (1) Use web_search and web_fetch for current information.
    (2) Use arxiv_search for preprints and recent academic work.
    (3) Use crossref_search for published literature.
    (4) Cross-reference multiple sources to verify information.
    (5) Cite sources with URLs, DOIs, or arXiv IDs.

  userRequest: |
    {{ INSTRUCTION }}
```

## Template Variables (Jinja2)

Prompts are processed using the Jinja2 templating engine, allowing you to insert dynamic information using `{{ variable_name }}` syntax. TeXRA provides several built-in variables based on the files and instructions you select in the UI.

This mechanism is sometimes referred to as **Variable Retrieval (VR)**: the extension loads your chosen inputs, references, figures, and any additional context, then exposes them as template variables.

### Common Variables

| Variable | Description |
|----------|-------------|
| `{{ INSTRUCTION }}` | The text entered into the "Instruction" box in the UI |
| `{{ INPUT_FILE }}` | Path of the primary input file |
| `{{ INPUT_CONTENT }}` | Full text content of the primary input file |
| `{{ REFERENCE_FILE }}` | Path of the primary reference file |
| `{{ REFERENCE_CONTENT }}` | Content of the primary reference file |
| `{{ AUXILIARY_FILE }}` | Path of the primary auxiliary file |
| `{{ AUXILIARY_CONTENT }}` | Content of the primary auxiliary file |
| `{{ EDITED_FILE }}` | Path of the edited file (used in `merge` agents) |
| `{{ EDITED_CONTENT }}` | Content of the edited file |
| `{{ MEDIA_FILE }}` | Path of the primary media file |

> **Note:** Media content is handled separately for multimodal models. See [Working with Figures](./working-with-figures.md).

### Multiple File Variables

| Variable | Description |
|----------|-------------|
| `{{ ALL_INPUTS }}` | XML string with all input files wrapped in `<document name="...">` tags |
| `{{ ALL_REFERENCES }}` | XML string for all reference files |
| `{{ ALL_AUXILIARYS }}` | XML string for all auxiliary files |
| `{{ ADDITIONAL_INPUTS }}` | Additional input files beyond the primary |
| `{{ LIST_OF_ALL_INPUTS }}` | Comma-separated list of input file paths |
| `{{ LIST_OF_ALL_REFERENCES }}` | Comma-separated list of reference file paths |
| `{{ LIST_OF_ALL_AUXILIARYS }}` | Comma-separated list of auxiliary file paths |

### Multiple Output Variables

| Variable | Description |
|----------|-------------|
| `{{ OUTPUT_FILES_ORDER }}` | Comma-separated string of output filenames from the UI |

See [Handling Multiple Files](./multiple-output.md) for details on multi-file output.

### Custom Variables from Settings

Files specified in agent settings are available as template variables:

- `requiredFiles` and `requiredFilesInternal`: Available as `{{ VARNAME_CONTENT }}`
- `filePatternsContain`: Matched files available as `{{ VARNAME_CONTENT }}`

Example:

```yaml
settings:
  requiredFiles:
    TEMPLATE: templates/paper.tex
  filePatternsContain:
    - pattern: 'commands'
      varName: COMMANDS
      categories: ['auxiliaryFile']

prompts:
  userPrefix: |
    Use this template: {{ TEMPLATE_CONTENT }}
    Math commands: {{ COMMANDS_CONTENT }}
```

### Conditional Logic

Use Jinja2 conditionals to handle optional inputs:

```yaml
userPrefix: |
  {% if INSTRUCTION %}
  Follow this instruction: {{ INSTRUCTION }}
  {% endif %}

  {% if ALL_AUXILIARYS %}
  Reference these files:
  {{ ALL_AUXILIARYS }}
  {% endif %}
```

### Model-Specific Prompts

Use the `IS_ANTHROPIC_MODEL` variable for model-specific instructions:

```yaml
systemPrompt: |
  You are a research assistant.
  {% if IS_ANTHROPIC_MODEL %}
  Do not create excessive markdown files unless explicitly requested.
  {% endif %}
```

## Multiple Output Agents

If your workflow requires several output files, set `isMultipleOutput: true` and structure the output using the `OUTPUT_FILES_ORDER` variable. Below is a simplified example based on the built-in `polish_multiple.yaml`:

```yaml
name: polish_multiple
inherits: polish
settings:
  agentType: CoT
  isMultipleOutput: true
  documentTag: latex_documents
  endTag: '</latex_documents>'
  defaultOutputFiles:
    - introduction.tex
    - conclusion.tex

prompts:
  userRequest:
    - |
      {% if OUTPUT_FILES_ORDER %}
      The output files should be in this order: {{ OUTPUT_FILES_ORDER }}.
      {% endif %}

      <scratchpad>
      - Plan revisions for each file
      </scratchpad>

      <latex_documents>
      <document name="{{ OUTPUT_FILES_ORDER[0] }}">
      % UPDATED_FILE_1
      </document>
      <document name="{{ OUTPUT_FILES_ORDER[1] }}">
      % UPDATED_FILE_2
      </document>
      </latex_documents>
```

TeXRA saves each `<document>` block to the corresponding filename. See [Handling Multiple Files](./multiple-output.md) for more details.

## Tool Usage Tips

> **Tip:** The `read_file` tool returns only the first 2,000 lines per request. Provide an optional `range` object (e.g., `{"start": 401, "end": 450}`) to page through larger files. Lines are prefixed with `cat -n` style line numbers. When copying text for `edit_file`, use only the content after the line-number prefix.

**Common workspace helpers:**

- `glob`: List files matching a pattern, sorted by modification time.
- `grep`: Run ripgrep searches. By default returns matching content lines; switch `output_mode` to `files_with_matches` or `count` to change the format.
- `ls`: Inspect directory contents with optional ignore globs.

The ProgressBoard shows the JSON passed to each tool along with the tool's response.

## Runtime XML Exports

Reflection-style agents automatically collect a lightweight summary of the XML they generate. The summary is exposed as `runtimeXmlExports` on the agent instance so pipeline orchestrators can forward results to follow-up steps.

The structure includes three fields:

- `tagContents`: Dictionary of detected XML tags. For `<document>` outputs this contains either a single string or an array of strings.
- `documents`: List of serialized `<document>` elements for pasting into the next prompt.
- `singleOutputFile`: The processed output path when the agent produced exactly one LaTeX document.

## Step 4: Save and Reload

1. Save your `.yaml` file.
2. Reload the VS Code window (Command Palette > `Developer: Reload Window`).
3. Your new custom agent should now appear in the "Agent" dropdown menu in the TeXRA UI.

## XML Extraction Requirements

TeXRA's `XmlOutputManager` parses the `<latex_document>` or `<latex_documents>` blocks in AI output:

- Tags must be properly closed.
- For multiple outputs, each `<document>` must include a `name` attribute matching a filename from the UI.
- If tags are mismatched or a filename is wrong, extraction fails and no files are saved.

## Best Practices

- **Start simple**: Begin with basic settings and prompts, then add complexity incrementally.
- **Use inheritance**: Inherit from a relevant built-in agent (like `correct` or `polish`) to save effort.
- **Test iteratively**: Test frequently and review logs in the ProgressBoard.
- **Read examples**: Examine the source `.yaml` files in `resources/agents/` and `resources/tool_use_agents/` for real-world patterns.

For more details on agent architecture and execution flow, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
