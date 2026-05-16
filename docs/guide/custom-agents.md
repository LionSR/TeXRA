# Custom Agents

Every lab has its own writing style, formatting quirks, and recurring tasks. Maybe your group always needs a "rewrite the abstract for a Nature-style letter" pass, or you want an agent that converts your internal notes into arXiv-ready LaTeX. Custom agents let you encode these workflows once and reuse them with a single click.

This guide walks you through creating your own agent definition files (`.yaml`) so TeXRA does exactly what your research needs—no coding required.

::: info Agent Fundamentals
Before creating a custom agent, it's highly recommended to understand the underlying concepts:

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Agent Architecture & Execution Flow**: Learn about the `.yaml` structure, settings, prompts, and how agents run. See the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- <wa-icon library="texra" name="sparkle"></wa-icon> **Built-in Agents**: Review the standard agents provided by TeXRA for examples and potential inheritance parents. See the [Built-in Agent Reference](./built-in-agents.md).
- <wa-icon library="texra" name="dashboard"></wa-icon> **Agents Tab**: Browse and manage agent files from the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
  :::

## <wa-icon library="texra" name="library"></wa-icon> Reference Agents

TeXRA includes ready-made reference agents you can use as starting points. Think of them as recipes: copy one into your custom agents directory, tweak it, and you have a new agent in minutes. Examples range from content-enhancement workflows to notation standardizers and multi-agent orchestrators. Each agent handles one input or several through a unified protocol: set `documentTag: documents` and your prompt emits one `<document name="...">` per input.

> **Migrating an older custom YAML?** See [agent-yaml-migration.md](./agent-yaml-migration.md) for the full before/after walk-through covering the W2/W3/W4 changes (auxiliary→context picker merge, `_multiple` retirement, single-slot collapse).

## <wa-icon library="texra" name="new-file"></wa-icon> Creating a Custom Agent File

Follow these steps to create a new custom agent.

### <wa-icon library="texra" name="folder-opened"></wa-icon> Step 1 — Locate or Configure the Custom Agents Directory

Custom agents live in a dedicated directory that TeXRA prepares for you.

1. **Find the Default Folder**: TeXRA automatically seeds a `custom_agents` directory inside its global storage. Open the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard to see its location.
2. **Override (Optional)**: If you prefer to manage agents elsewhere, open the **Agents** tab and click **Change** (<wa-icon library="texra" name="edit"></wa-icon>) in the directory info bar to pick a new folder. TeXRA will ensure that directory exists and use it instead of the default.

### <wa-icon library="texra" name="wand"></wa-icon> Automatic Creation

If you'd like TeXRA to draft an agent for you, click **New Agent** (<wa-icon library="texra" name="add"></wa-icon>) in the **Agents** tab. The wizard only asks for a short description and the default output filenames. TeXRA sends that info to a Claude model, which returns the YAML enclosed in `<yaml>...</yaml>` tags. The extension extracts the content between those tags and saves it as a basic CoT template (single or multiple files) in your Custom Agents folder.

### <wa-icon library="texra" name="file-add"></wa-icon> Step 2 — Create a New YAML File

1. In the **Agents** tab, click **From Template** (<wa-icon library="texra" name="file-code"></wa-icon>) to create a new agent YAML file in your custom agents directory.
2. Alternatively, click **Open Folder** (<wa-icon library="texra" name="folder-opened"></wa-icon>) to open the directory and create a `.yaml` file manually.
3. Choose a descriptive name using underscores and ending with `.yaml` (e.g. `literature_review_generator.yaml`).

### <wa-icon library="texra" name="edit"></wa-icon> Step 3 — Define the Agent

Open the newly created `.yaml` file and you'll find a starter template already inserted. Customize it to define your agent's structure. Here are the key fields:

```yaml
# --- Agent Inheritance (Optional) ---
# Specify a built-in or other custom agent to inherit settings and prompts from.
# See guide/built-in-agents.md for potential parents.
inherits: base # Or polish, correct, etc.

# --- Agent Settings ---
# Define the agent's core behavior and operational parameters.
# Override parent settings here if inheriting.
settings:
  # Core Behavior
  agentCategory: workflow # 'workflow' for structured reasoning with XML-wrapped output, or 'toolUse' for interactive agents that call tools (file editing, web search, etc.)
  temperature: 0.1 # LLM creativity (0.0 = deterministic, >0 = more random). Can be overridden by user settings.
  isRewrite: true # Does the agent primarily rewrite existing content (true) or generate new content (false)?

  # Output Handling
  documentTag: document # The main XML tag wrapping the agent's final output (required for CoT).
  endTag: '</document>' # The closing tag that signals the agent has finished its main output.
  prefills:
    - "<document>\n" # List of strings the AI should start its response(s) with.
      # Item [0] is for Round 0, Item [1] is for Round 1 (reflection).
      # Crucial for models needing specific start formats (e.g., XML tags).

  # File Handling (Optional - Advanced)
  # requiredFiles:
  #   TEMPLATE: path/to/template.tex # Map variable names to required file paths relative to workspace.
  # requiredFilesInternal:
  #   STYLE_GUIDE: styles/internal_style.css # Map variable names to files relative to the agent's YAML file location.
  # filePatternsContain:
  #   - pattern: 'bibliography' # Find files whose names contain this pattern.
  #     varName: BIBLIOGRAPHY # Make content available via {{ BIBLIOGRAPHY_CONTENT }} in prompts.
  #     categories: ['contextFile', 'contextFiles'] # Search within these UI file categories.
  # defaultOutputFiles: # Used when the agent is designed to produce multiple outputs.
  #   - 'introduction.tex'
  #   - 'methods.tex'

# --- Agent Prompts ---
# Define the text templates used to instruct the LLM.
# Override parent prompts here if inheriting.
prompts:
  systemPrompt: |
    # Defines the AI's role, core instructions, constraints, overall persona.
    # Sent once at the beginning (for supported models).
    [Define the AI's role and core instructions]

  userPrefix: |
    # Provides introductory text, main context (input files, user instruction).
    # Variables like `{{ INPUT_CONTENT }}`, `{{ INSTRUCTION }}`, `{{ BIBLIOGRAPHY_CONTENT }}` (from filePatternsContain) are substituted here.
    [Define context, instructions, and input variables like `{{ INPUT_CONTENT }}`]

  userRequest:
    - |
      # The prompt for the AI's first round of work (Round 0).
      # Often includes guidance for thinking (<scratchpad>) and output structure (<documentTag>).
      [Define the initial task prompt, potentially including scratchpad guidance]
    - |
      # Optional follow-up prompt for reflection rounds (Round 1+).
      # Duplicate or remove items to control how many reflections TeXRA schedules automatically.
      [Define how the model should critique or iterate on its previous output]
```

> **Reflection Tips:** When `userRequest` is an array, TeXRA takes the first
> entry as the initial request and treats the remaining entries as reflection
> prompts. If a run requests more reflections than the list provides, the first
> reflection template is reused.

#### <wa-icon library="texra" name="symbol-variable"></wa-icon> Using Variables in Prompts (Jinja2 Templating)

Prompts are processed using the Jinja2 templating engine, allowing you to insert dynamic information using `&#123;&#123; variable_name &#125;&#125;` syntax. TeXRA provides several built-in variables based on the files and instructions you select in the UI:

This mechanism is sometimes referred to as **Variable Retrieval (VR)**—the extension loads your chosen inputs, references, figures, and any additional context, then exposes them as template variables. For example, the text content of your main file becomes `&#123;&#123; INPUT_CONTENT &#125;&#125;` while the full list of selected files can be accessed through `&#123;&#123; ALL_INPUTS &#125;&#125;`. When you run the agent these placeholders are replaced with real data.

**Common Variables:**

- &#123;&#123; INSTRUCTION &#125;&#125;: The text entered into the "Instruction" box in the UI.
- &#123;&#123; INPUT_FILE &#125;&#125;: The path of the primary input file.
- &#123;&#123; INPUT_CONTENT &#125;&#125;: The full text content of the primary input file.
- &#123;&#123; CONTEXT_FILE &#125;&#125;: Path of the primary context file.
- &#123;&#123; CONTEXT_CONTENT &#125;&#125;: Content of the primary context file.
- &#123;&#123; EDITED_FILE &#125;&#125;: Path of the edited file (used in `merge`).
- &#123;&#123; EDITED_CONTENT &#125;&#125;: Content of the edited file.
- &#123;&#123; MEDIA_FILE &#125;&#125;: Path of the primary media file.
  \_Note: Media content itself isn't directly inserted as text; it's handled separately for multimodal models. See [Working with Figures](./working-with-figures.md).\*

**Multiple File Variables:**

- &#123;&#123; ALL_INPUTS &#125;&#125;: XML string containing all selected input files (primary + multiple) wrapped in `<document name="...">...</document>` tags.
- &#123;&#123; ALL_CONTEXTS &#125;&#125;: Similar XML string for all context files (the read-only context category that combines what used to be split into "reference" and "auxiliary").
- &#123;&#123; LIST_OF_ALL_INPUTS &#125;&#125;: Simple comma-separated string listing all input file paths.
- &#123;&#123; LIST_OF_ALL_CONTEXTS &#125;&#125;: Similar comma-separated list for context files.
- Legacy custom agents can still read `REFERENCE_*` and `AUXILIARY_*` aliases, but new agents should use `CONTEXT_*`.

**Multiple Document Output:**

- &#123;&#123; INPUT_FILES &#125;&#125;: Array of input filenames. Editing agents
  should iterate over this list and emit one `<document name="...">` block per
  input filename, preserving the input order and names. Use
  `&#123;&#123; INPUT_FILES | join(", ") &#125;&#125;` for a human-readable list. See
  [Handling Multiple Files](./multiple-output.md).
- &#123;&#123; OUTPUT_FILES &#125;&#125;: Array of declared generated output filenames.
  This is only populated for agents that set `defaultOutputFiles` or receive an
  explicit generated output list.

**Custom Variables (from `settings`):**

- Files specified in `requiredFiles` or `requiredFilesInternal` are available as `&#123;&#123; VARNAME_CONTENT &#125;&#125;` (e.g., `&#123;&#123; TEMPLATE_CONTENT &#125;&#125;`).
- Files matched by `filePatternsContain` are available as `&#123;&#123; VARNAME_CONTENT &#125;&#125;` (e.g., `&#123;&#123; BIBLIOGRAPHY_CONTENT &#125;&#125;`).
- When agents finish, TeXRA automatically captures detected XML segments so orchestrated workflows can reuse them without going through the file picker again (details below).

**Example Usage in `userPrefix`:**

```yaml
userPrefix: |
  Please process the main document: {{ INPUT_FILE }}
  <document name="{{ INPUT_FILE }}">
  {{ INPUT_CONTENT }}
  </document>

  Refer to these context files:
  {{ ALL_CONTEXTS }}

  Apply the following instruction:
  <instruction>{{ INSTRUCTION }}</instruction>
```

**Key Considerations:**

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Architecture Overview:** For a high-level understanding of the execution flow and how prompts/settings interact, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- <wa-icon library="texra" name="type-hierarchy"></wa-icon> **Inheritance:** Inheriting from a relevant built-in agent (like `correct` or `polish`) can save significant effort. Only define the settings and prompts you need to change.
- <wa-icon library="texra" name="files"></wa-icon> **Multiple Outputs:** If your agent needs to generate multiple distinct files, ensure your prompts generate the required XML structure. See the [Handling Multiple Files](./multiple-output.md) guide.
- <wa-icon library="texra" name="rocket"></wa-icon> **Start Simple:** Begin with basic settings/prompts and add complexity incrementally.
- <wa-icon library="texra" name="debug-alt"></wa-icon> **Test Iteratively:** Test frequently and review logs in the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>).

### <wa-icon library="texra" name="link"></wa-icon> Chaining Agents Together

After a workflow agent finishes, TeXRA captures the output so follow-up steps can reuse it without another trip through the file picker. This is how multi-stage pipelines work—for example, an orchestrator agent can run a `polish` step, then automatically hand the result to a `correct` step, all in a single session.

You don't need to configure this yourself; it happens automatically when an agent definition includes orchestration prompts. See the reference agents for working examples.

### <wa-icon library="texra" name="tools"></wa-icon> Tool-Use Agents

Tool-use agents are interactive: instead of producing a single polished file, they hold a conversation and take actions on your behalf — reading and editing files, searching the web, looking up papers, and more.

**Typical user story:** You're writing up results for a conference submission and realise you need three new BibTeX entries, a TikZ architecture diagram, and a consistency pass across four `.tex` files. Rather than juggling browser tabs and terminal windows, you open a `research` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and describe what you need. The agent reads your project, searches arXiv for the missing references, drafts the TikZ code, and edits the files — all in one session.

To create your own tool-use agent, set `agentCategory: toolUse` and list the tools you want to grant. TeXRA groups tools by category (matching **Dashboard → Tools** <wa-icon library="texra" name="tools"></wa-icon>):

| Category                                                                        | What it lets the agent do                                           | Example tool names                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| <wa-icon library="texra" name="files"></wa-icon> **File & Shell**               | Read, write, edit, search, list, and run commands in your project   | `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`, `bash`                                     |
| <wa-icon library="texra" name="file-code"></wa-icon> **LaTeX**                  | Extract figures, TikZ, and bibliography; report compile diagnostics | `extract_figures`, `extract_tikz_figures`, `extract_bib_entries`, `diagnostics`, `texcount`              |
| <wa-icon library="texra" name="mortar-board"></wa-icon> **Academic Research**   | Search arXiv and Crossref, resolve DOIs, manage Zotero              | `arxiv_search`, `arxiv_metadata`, `download_arxiv_source`, `crossref_doi`, `crossref_search`, `zotero_*` |
| <wa-icon library="texra" name="globe"></wa-icon> **Web**                        | Fetch pages and search the internet                                 | `web_search`, `web_fetch`                                                                                |
| <wa-icon library="texra" name="symbol-operator"></wa-icon> **Computation**      | Run Wolfram Language, delegate to Codex, consult another chat model | `wolfram`, `codex`, `inquiry`                                                                            |
| <wa-icon library="texra" name="beaker"></wa-icon> **Lean 4**                    | Check Lean proofs and search Mathlib                                | `lean_diagnostics`, `lean_inspect`, `lean_loogle`, `lean_file`, `lean_project`                           |
| <wa-icon library="texra" name="type-hierarchy"></wa-icon> **Memory & Workflow** | Persistent memory, to-do lists, sub-agent delegation                | `memory`, `todo_write`, `plan`, `delegate_workflow`, `delegate_agent`, `executions`, `accept_run_files`  |

For the exact tool names to list in your YAML, browse any of the built-in tool-use agents (like `research`, `search`, `ask`, or `code`) in the **Agents** tab — their `tools:` array shows exactly which tools are wired up.

Example skeleton:

```yaml
settings:
  agentCategory: toolUse
  tools:
    - read_file
    - write_file
    - edit_file
    - glob
    - grep
    - web_search
```

The ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs every tool call and its result, so you can always see what the agent is doing.

### <wa-icon library="texra" name="files"></wa-icon> Example: Multiple Output Agent

If your workflow requires several output files, your agent must structure its
response using the appropriate filename list. Below is a simplified template
for a workflow agent that writes two generated output files:

```yaml
inherits: polish
settings:
  agentCategory: workflow
  documentTag: documents
  endTag: </documents>
  defaultOutputFiles:
    - introduction.tex
    - conclusion.tex

prompts:
  userRequest: |
    The output files should be in this order: {{ OUTPUT_FILES | join(", ") }}.

    <scratchpad>
    - Plan revisions for each file
    </scratchpad>

    <documents>
    {% for output in OUTPUT_FILES %}
    <document name="{{ output }}">
    % UPDATED_CONTENT_FOR_{{ output }}
    </document>
    {% endfor %}
    </documents>
```

This structure lets TeXRA save each `<document>` block to the corresponding
filename from the selected input list or from `settings.defaultOutputFiles`. See
[Handling Multiple Files](./multiple-output.md) for more details.

### <wa-icon library="texra" name="save"></wa-icon> Step 4 — Save and Reload

1. Save your `.yaml` file.
2. Reload the VS Code window (Command Palette → `Developer: Reload Window`).
3. Your new custom agent should now appear in the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>) of the TeXRA UI.

### <wa-icon library="texra" name="shield"></wa-icon> Strict XML Extraction

TeXRA expects the model's output to use properly closed XML tags. For agents producing multiple files, each `<document>` block must include a `name` attribute matching one of the filenames from the UI. If tags are mismatched or a filename doesn't match, extraction fails and no files are saved — check the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs for details.

For more examples and advanced options, browse the built-in agent definitions through the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
