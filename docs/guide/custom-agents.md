# Custom Agents

TeXRA allows you to create custom agents tailored to your specific academic research needs. This is where you can truly unleash the power of AI for your unique workflows (or just make an agent that writes everything in pirate speak, we won't judge). This guide focuses on the practical steps of creating the agent definition (`.yaml`) file.

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
2.  **Configure (Optional)**: If the folder doesn't exist or you want to use a different location, set the path in VS Code Settings (`Ctrl+,`) under `texra.explorer.agentsDirectory`.

### Step 2: Create a New YAML File

1.  Using the [Agent Explorer](./agent-explorer.md), right-click within your "Custom Agents" directory (or a subfolder).
2.  Select "New File".
3.  You'll be prompted for a name. Choose a descriptive name using underscores and ending with `.yaml` (e.g., `literature_review_generator.yaml`).

### Step 3: Define the Agent

Open the newly created `.yaml` file and define your agent's structure. Start with a basic template and customize it. Here are the key fields:

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
  agentType: CoT # Type: 'CoT' (Chain of Thought) for complex reasoning with scratchpads, or 'direct' for simpler, direct output.
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

### Step 4: Save and Reload

1.  Save your `.yaml` file.
2.  Reload the VS Code window (Command Palette > `Developer: Reload Window`).
3.  Your new custom agent should now appear in the "Agent" dropdown menu in the TeXRA UI.

For more complex examples and advanced configuration options like `requiredFiles` and `filePatternsContain`, examine the source `.yaml` files of the [Built-in Agents](./built-in-agents.md).
