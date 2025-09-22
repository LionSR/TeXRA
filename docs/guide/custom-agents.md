# Custom Agents

TeXRA is a VS Code extension that orchestrates AI-driven writing tools using YAML agent files. Each agent follows a chain-of-thought workflow with scratchpad planning and a final XML-wrapped output. This guide focuses on creating those definition (`.yaml`) files so you can tailor TeXRA to your research needs (or make an agent that writes everything in pirate speak—we won't judge).

::: info Agent Fundamentals
Before creating a custom agent, it's highly recommended to understand the underlying concepts:

- **Agent Architecture & Execution Flow**: Learn about the `.yaml` structure, settings, prompts, and how agents run. See the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- **Built-in Agents**: Review the standard agents provided by TeXRA for examples and potential inheritance parents. See the [Built-in Agent Reference](./built-in-agents.md).
- **Agent Explorer**: Learn how to browse and manage agent files using the [Agent Explorer](./agent-explorer.md) view in the TeXRA sidebar.
  :::

## Creating a Custom Agent File

Follow these steps to create a new custom agent:

### Step 1: Locate or Configure the Custom Agents Directory

Custom agents reside in a specific directory.

1.  **Find Existing**: Look for the "Custom Agents" folder within the [Agent Explorer](./agent-explorer.md).
2.  **Configure (Optional)**: If the folder doesn't exist or you want to use a different location, set the absolute path in VS Code Settings (`Ctrl+,`) under `texra.explorer.agentsDirectory`.

### Automatic Creation

If you'd like TeXRA to draft an agent for you, use the **Create AI Agent** <i class="codicon codicon-sparkle"></i> button in the Agent Explorer title bar. The wizard only asks for a short description and the default output filenames. TeXRA sends this information to a Claude model, which replies with the YAML enclosed in `<yaml>...</yaml>` tags. The extension extracts the content between those tags and saves it as a basic CoT template (single or multiple files) in your Custom Agents folder.

### Step 2: Create a New YAML File

1.  Using the [Agent Explorer](./agent-explorer.md), right-click within your "Custom Agents" directory (or a subfolder).
2.  Select "New File".
3.  You'll be prompted for a name. Choose a descriptive name using underscores and ending with `.yaml` (e.g., `literature_review_generator.yaml`).

### Step 3: Define the Agent

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
  agentType: CoT # Type: 'CoT' (Chain of Thought) for complex reasoning with scratchpads, 'direct' for simpler direct output, or 'toolUse' for agents that call model tools.
  temperature: 0.1 # LLM creativity (0.0 = deterministic, >0 = more random). Can be overridden by user settings.
  isRewrite: true # Boolean: Does the agent primarily rewrite existing content (true) or generate new content (false)? Affects some internal handling.

  # Output Handling
  documentTag: document # The main XML tag wrapping the agent's final output (required for CoT).
  endTag: '</document>' # The closing tag that signals the agent has finished its main output.
  outputExt: tex # Default file extension for the output file (e.g., tex, md, txt).
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
  #     categories: ['auxiliaryFile', 'auxiliaryFiles'] # Search within these UI file categories.
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

  userRequest: |
    # The prompt for the AI's first round of work (Round 0).
    # Often includes guidance for thinking (<scratchpad>) and output structure (<documentTag>).
    [Define the initial task prompt, potentially including scratchpad guidance]

  # userReflect: | # Optional: Only needed if you plan to use reflect=true
  #   The prompt for the AI's second round (Round 1) asking it to critique and improve its Round 0 output.
  #   [Define the reflection prompt]
```

#### Using Variables in Prompts (Jinja2 Templating)

Prompts are processed using the Jinja2 templating engine, allowing you to insert dynamic information using `{{ variable_name }}` syntax. TeXRA provides several built-in variables based on the files and instructions you select in the UI:

This mechanism is sometimes referred to as **Variable Retrieval (VR)**—the extension loads your chosen inputs, references, figures, and any additional context, then exposes them as template variables. For example, the text content of your main file becomes `{{ INPUT_CONTENT }}` while the full list of selected files can be accessed through `{{ ALL_INPUTS }}`. When you run the agent these placeholders are replaced with real data.

**Common Variables:**

- &#123;&#123; INSTRUCTION &#125;&#125;: The text entered into the "Instruction" box in the UI.
- &#123;&#123; INPUT_FILE &#125;&#125;: The path of the primary input file.
- &#123;&#123; INPUT_CONTENT &#125;&#125;: The full text content of the primary input file.
- &#123;&#123; REFERENCE_FILE &#125;&#125;: Path of the primary reference file.
- &#123;&#123; REFERENCE_CONTENT &#125;&#125;: Content of the primary reference file.
- &#123;&#123; AUXILIARY_FILE &#125;&#125;: Path of the primary auxiliary file.
- &#123;&#123; AUXILIARY_CONTENT &#125;&#125;: Content of the primary auxiliary file.
- &#123;&#123; EDITED_FILE &#125;&#125;: Path of the edited file (used in `merge`).
- &#123;&#123; EDITED_CONTENT &#125;&#125;: Content of the edited file.
- &#123;&#123; MEDIA*FILE &#125;&#125;: Path of the primary media file.
  \_Note: Media content itself isn't directly inserted as text; it's handled separately for multimodal models. See [Working with Figures](./working-with-figures.md).*

**Multiple File Variables:**

- &#123;&#123; ALL_INPUTS &#125;&#125;: XML string containing all selected input files (primary + multiple) wrapped in `<document name="...">...</document>` tags.
- &#123;&#123; ALL_REFERENCES &#125;&#125;: Similar XML string for all reference files.
- &#123;&#123; ALL_AUXILIARYS &#125;&#125;: Similar XML string for all auxiliary files.
- &#123;&#123; LIST_OF_ALL_INPUTS &#125;&#125;: Simple comma-separated string listing all input file paths.
- &#123;&#123; LIST_OF_ALL_REFERENCES &#125;&#125;: Similar comma-separated list for reference files.
- &#123;&#123; LIST_OF_ALL_AUXILIARYS &#125;&#125;: Similar comma-separated list for auxiliary files.

**Multiple Output Variable:**

- &#123;&#123; OUTPUT_FILES_ORDER &#125;&#125;: Comma-separated string listing the output filenames specified in the UI. Crucial for agents generating multiple files. See [Handling Multiple Files](./multiple-output.md).

**Custom Variables (from `settings`):**

- Files specified in `requiredFiles` or `requiredFilesInternal` are available as `{{ VARNAME_CONTENT }}` (e.g., `{{ TEMPLATE_CONTENT }}`).
- Files matched by `filePatternsContain` are available as `{{ VARNAME_CONTENT }}` (e.g., `{{ BIBLIOGRAPHY_CONTENT }}`).

**Example Usage in `userPrefix`:**

```yaml
userPrefix: |
  Please process the main document: {{ INPUT_FILE }}
  <document name="{{ INPUT_FILE }}">
  {{ INPUT_CONTENT }}
  </document>

  Refer to these auxiliary files:
  {{ ALL_AUXILIARYS }}

  Apply the following instruction:
  <instruction>{{ INSTRUCTION }}</instruction>
```

**Key Considerations:**

- **Architecture Overview:** For a high-level understanding of the execution flow and how prompts/settings interact, see the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- **Inheritance:** Inheriting from a relevant built-in agent (like `correct` or `polish`) can save significant effort. Only define the settings and prompts you need to change.
- **Multiple Outputs:** If your agent needs to generate multiple distinct files, ensure your prompts generate the required XML structure. See the [Handling Multiple Files](./multiple-output.md) guide.
- **Start Simple:** Begin with basic settings/prompts and add complexity incrementally.
- **Test Iteratively:** Test frequently and review logs in the ProgressBoard.

### Tool-Use Agents

Tools live under `src/tools/` and each one defines its input schema with Zod.
List the desired tools by name in your agent YAML. The registry includes
workspace utilities like `bash`, `read_file`, `write_file`, `edit_file`,
`file_op`, `glob`, `grep`, and `ls` alongside domain-specific helpers such as
`str_replace_editor`, `wolfram`,
`web_fetch`, and `web_search`.

For a minimal read-only configuration, see the built-in `ask` agent
(`resources/tool_use_agents/ask.yaml`), which only grants `read_file`, `glob`,
`grep`, and `ls` access.

Common workspace helpers:

- `glob` — Quickly list files matching a pattern, sorted by modification time.
- `grep` — Run ripgrep searches without leaving the workspace sandbox.
- `ls` — Inspect directory contents with optional ignore globs.

Example:

```yaml
settings:
  agentType: toolUse
  tools:
    - str_replace_editor
    - wolfram
    - glob
    - grep
    - ls
    - bash
    - read_file
    - write_file
    - edit_file
    - web_fetch
    - web_search
```

The ProgressBoard shows the JSON passed to each tool along with the tool's
response.

### Example: Multiple Output Agent

If your workflow requires several output files, your agent must structure its
response using the `OUTPUT_FILES_ORDER` variable. Below is a simplified template
similar to the built-in `polish_multiple.yaml`:

```yaml
inherits: polish
settings:
  agentType: CoT
  documentTag: latex_documents
  endTag: </latex_documents>
  defaultOutputFiles:
    - introduction.tex
    - conclusion.tex

prompts:
  userRequest: |
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

This structure lets TeXRA save each `<document>` block to the corresponding
filename from the UI list. See [Handling Multiple Files](./multiple-output.md)
for more details.

### Step 4: Save and Reload

1.  Save your `.yaml` file.
2.  Reload the VS Code window (Command Palette > `Developer: Reload Window`).
3.  Your new custom agent should now appear in the "Agent" dropdown menu in the TeXRA UI.

### Strict XML Extraction

TeXRA's `XmlOutputManager` parses the `<latex_document>` or `<latex_documents>` blocks in the AI output.
It requires properly closed tags and, for multiple outputs, each `<document>` must include a `name` attribute that matches a filename from the UI.
If tags are mismatched or a filename is wrong, extraction fails and no files are saved.

For more complex examples and advanced configuration options like `requiredFiles` and `filePatternsContain`, examine the source `.yaml` files of the [Built-in Agents](./built-in-agents.md).
