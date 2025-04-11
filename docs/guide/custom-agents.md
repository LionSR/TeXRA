# Custom Agents

TeXRA allows you to create custom agents tailored to your specific academic research needs. This guide focuses on the practical steps of creating the agent definition (`.yaml`) file.

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

Open the newly created `.yaml` file and define your agent's structure. Start with a basic template and customize it:

```yaml
# Custom agent for [Your Agent's Purpose]
# Author: [Your Name]
# Date: [Creation Date]

# Optional: Specify a built-in or other custom agent to inherit from
# See docs/guide/built-in-agents.md for potential parents
inherits: base # Or polish, correct, etc.

# Define settings to override or add to the parent (if inheriting)
settings:
  agentType: CoT # Or direct
  temperature: 0.1
  # Add other settings as needed (documentTag, endTag, outputExt, prefills, etc.)
  # Refer to docs/guide/agent-architecture.md for details on settings

# Define prompts to override or add to the parent (if inheriting)
prompts:
  systemPrompt: |
    [Define the AI's role and core instructions]
    Refer to docs/guide/agent-architecture.md for prompt details.

  userPrefix: |
    [Define context, instructions, and input variables like {{ INPUT_CONTENT }}]

  userRequest: |
    [Define the initial task prompt, potentially including scratchpad guidance]

  # userReflect: | # Optional: Only needed if you plan to use reflect=true
  #   [Define the reflection prompt]
```

**Key Considerations:**

- **Refer to Architecture:** Constantly refer back to the [Agent Architecture & Execution Flow](./agent-architecture.md) guide to understand the purpose and impact of each `settings` field and `prompts` section.
- **Inheritance:** Inheriting from a relevant built-in agent (like `correct` or `polish`) can save significant effort. Only define the settings and prompts you need to change.
- **Multiple Outputs:** If your agent needs to generate multiple distinct files, you must design your prompts (especially `userRequest` and `userReflect`) to produce the required XML structure with named `<document>` tags. See the [Handling Multiple Files](./multiple-output.md) guide for details.
- **Start Simple:** Begin with a basic version of your agent and incrementally add complexity (e.g., required files, file patterns) as needed.
- **Test Iteratively:** Test your agent frequently using the TeXRA UI and review the logs in the ProgressBoard.

### Step 4: Save and Reload

1.  Save your `.yaml` file.
2.  Reload the VS Code window (Command Palette > `Developer: Reload Window`).
3.  Your new custom agent should now appear in the "Agent" dropdown menu in the TeXRA UI.

For more complex examples and advanced configuration options like `requiredFiles` and `filePatternsContain`, refer to the examples within the [Agent Architecture & Execution Flow](./agent-architecture.md) guide and examine the source `.yaml` files of the [Built-in Agents](./built-in-agents.md).
