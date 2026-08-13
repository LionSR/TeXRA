# Custom Agents

<script setup>
import ToolCategoriesHero from '../.vitepress/components/ToolCategoriesHero.vue';
import AgentAnatomyHero from '../.vitepress/components/AgentAnatomyHero.vue';
import OutputMappingHero from '../.vitepress/components/OutputMappingHero.vue';
import CliAgentShowHero from '../.vitepress/components/CliAgentShowHero.vue';
</script>

Every lab has its own writing style, formatting quirks, and recurring tasks. Maybe your group always needs a "rewrite the abstract for a Nature-style letter" pass, or you want an agent that converts your internal notes into arXiv-ready LaTeX. Custom agents let you encode these workflows once and reuse them with a single click.

This guide walks you through creating your own agent definition files (`.yaml`) so TeXRA does exactly what your research needs—no coding required.

::: info Agent Fundamentals
Before creating a custom agent, it's highly recommended to understand the underlying concepts:

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Agent Architecture & Execution Flow**: Learn about the `.yaml` structure, settings, prompts, and how agents run. See the [Agent Architecture & Execution Flow](./agent-architecture.md) guide.
- <wa-icon library="texra" name="sparkle"></wa-icon> **Built-in Agents**: Review the standard agents provided by TeXRA for examples and potential inheritance parents. See the [Built-in Agent Reference](./built-in-agents.md).
- <wa-icon library="texra" name="dashboard"></wa-icon> **Agents Tab**: Browse and manage agent files from the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
  :::

## <wa-icon library="texra" name="library"></wa-icon> Reference Agents

TeXRA includes ready-made reference agents you can use as starting points. Think of them as recipes: copy one into your custom agents directory, tweak it, and you have a new agent in minutes. Examples range from content-enhancement workflows to notation standardizers and multi-agent orchestrators. Each agent handles one input or several through the fixed `<documents>` container and emits one `<document name="...">` per input.

## <wa-icon library="texra" name="new-file"></wa-icon> Creating a Custom Agent File

Follow these steps to create a new custom agent.

### <wa-icon library="texra" name="folder-opened"></wa-icon> Step 1 — Locate or Configure the Custom Agents Directory

Custom agents live in a dedicated directory that TeXRA prepares for you.

1. **Find the Default Folder**: TeXRA automatically seeds a `custom_agents` directory inside its global storage. Open the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard to see its location.
2. **Override (Optional)**: If you prefer to manage agents elsewhere, open the **Agents** tab and click **Change** (<wa-icon library="texra" name="edit"></wa-icon>) in the directory info bar to pick a new folder. TeXRA will ensure that directory exists and use it instead of the default.

### <wa-icon library="texra" name="wand"></wa-icon> Automatic Creation

If you'd like TeXRA to draft an agent for you, click **New Agent** (<wa-icon library="texra" name="add"></wa-icon>) in the **Agents** tab. The wizard asks for the agent name and a short description (tool-use agents additionally let you pick the tools to grant). TeXRA sends that info to your configured helper model, which returns the YAML enclosed in `<yaml>...</yaml>` tags. The extension extracts the content between those tags and saves it as a template in your Custom Agents folder (falling back to a built-in template if generation fails).

### <wa-icon library="texra" name="file-add"></wa-icon> Step 2 — Create a New YAML File

1. In the **Agents** tab, click **From Template** (<wa-icon library="texra" name="file-code"></wa-icon>) to create a new agent YAML file in your custom agents directory.
2. Alternatively, click **Open Folder** (<wa-icon library="texra" name="folder-opened"></wa-icon>) to open the directory and create a `.yaml` file manually.
3. Choose a descriptive name using underscores and ending with `.yaml` (e.g. `literature_review_generator.yaml`).

### <wa-icon library="texra" name="edit"></wa-icon> Step 3 — Define the Agent

Open the newly created `.yaml` file and you'll find a starter template already inserted. An agent is just three labelled sections plus one mapping you need to keep in mind:

<AgentAnatomyHero />

<p class="hero-caption">An agent file is <code>inherits</code> + <code>settings</code> + <code>prompts</code>; the <code>userRequest</code> array maps position-by-position onto rounds (item <code>[0]</code> is Round 0, item <code>[1]</code> the first reflection).</p>

Customize it to define your agent's structure. Here are the key fields:

```yaml
# --- Agent Inheritance (Optional) ---
# Specify a built-in or other custom agent to inherit settings and prompts from.
# See guide/built-in-agents.md for potential parents.
inherits: polish # Or correct, merge, etc.

# --- Agent Settings ---
# Define the agent's core behavior and operational parameters.
# Override parent settings here if inheriting.
settings:
  # Core Behavior
  agentCategory: workflow # 'workflow' for structured reasoning with XML-wrapped output, or 'toolUse' for interactive agents that call tools (file editing, web search, etc.)
  temperature: 0.1 # LLM creativity (0.0 = deterministic, >0 = more random). Can be overridden by user settings.
  isRewrite: true # Does the agent primarily rewrite existing content (true) or generate new content (false)?
  rounds: 2 # Maximum number of passes (Round 0 plus reflection rounds). The actual count is max(rounds, number of userRequest entries); a run can still stop early once the model signals it is finished.

  # File Handling (Optional - Advanced)
  # requiredFilesInternal:
  #   STYLE_GUIDE: styles/internal_style.css # Map variable names to files the agent bundles, relative to its YAML file location. Workspace files are attached per run as context files instead.
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
    # Variables like `{{ INPUT_CONTENT }}`, `{{ INSTRUCTION }}`, `{{ ALL_CONTEXTS }}` are substituted here.
    [Define context, instructions, and input variables like `{{ INPUT_CONTENT }}`]

  userRequest:
    - |
      # The prompt for the AI's first round of work (Round 0).
      # Often includes guidance for thinking (<scratchpad>) and the fixed <documents> output structure.
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

#### <wa-icon library="texra" name="symbol-variable"></wa-icon> Using Variables in Prompts (Nunjucks Templating)

Prompts are processed using the Nunjucks templating engine (Jinja2-style syntax), allowing you to insert dynamic information using `{{ variable_name }}` syntax. TeXRA provides several built-in variables based on the files and instructions you select in the UI:

This mechanism is sometimes referred to as **Variable Retrieval (VR)**—the extension loads your chosen inputs, references, figures, and any additional context, then exposes them as template variables. For example, the text content of your main file becomes `{{ INPUT_CONTENT }}` while the full list of selected files can be accessed through `{{ ALL_INPUTS }}`. When you run the agent these placeholders are replaced with real data.

<TemplateVarsPalette />

The naming follows one rule: `*_FILE` gives you a path, `*_CONTENT` gives you
that file's text, `ALL_*` bundles every selected file into one
`<document name="...">…</document>` XML string, and `LIST_OF_*` gives the same
set as a comma-separated path list. Media is the exception — `MEDIA_FILE` is a
path, but the media itself is sent to multimodal models separately rather than
inlined as text (see [Working with Figures](./working-with-figures.md)).

**Multiple Document Output:**

- &#123;&#123; INPUT_FILES &#125;&#125;: Array of input filenames. Editing agents
  should iterate over this list and emit one `<document name="...">` block per
  input filename, preserving the input order and names. Use
  `{{ INPUT_FILES | join(", ") }}` for a human-readable list. See
  [Handling Multiple Files](./multiple-output.md).
- &#123;&#123; OUTPUT_FILES &#125;&#125;: Array of declared generated output filenames.
  This is only populated for agents that set `defaultOutputFiles` or receive an
  explicit generated output list.

**Custom Variables (from `settings`):**

- Files specified in `requiredFilesInternal` are available as `{{ VARNAME_CONTENT }}` (e.g., `{{ TEMPLATE_CONTENT }}`).
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

To create your own tool-use agent, set `agentCategory: toolUse` and list the tools you want to grant. TeXRA groups tools by category (matching **Dashboard → Tools** <wa-icon library="texra" name="tools"></wa-icon>) — each chip below is a token you can drop straight into your `tools:` array:

<ToolCategoriesHero />

<p class="hero-caption">The seven grantable tool categories on <strong>Dashboard → Tools</strong>; every chip is a name you can list verbatim in your agent's <code>tools:</code> array.</p>

For the exact tool names to list in your YAML, browse any of the built-in tool-use agents (like `research`, `review`, `lean`, or `numerics`) in the **Agents** tab — their `tools:` array shows exactly which tools are wired up.

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
filename from the selected input list or from `settings.defaultOutputFiles`:

<OutputMappingHero />

<p class="hero-caption">Each <code>&lt;document name="…"&gt;</code> block is saved to the file whose name matches; a <code>name</code> that isn't in the declared list is skipped and nothing is written.</p>

See [Handling Multiple Files](./multiple-output.md) for more details.

### <wa-icon library="texra" name="save"></wa-icon> Step 4 — Save and Run

1. Save your `.yaml` file.
2. TeXRA watches the custom agents directory, so your new agent appears automatically in the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>) of the TeXRA UI — no window reload needed.

From a terminal the iteration loop is faster — no window reload needed.
Verify the agent registered, then smoke-test it in one go:

<CliAgentShowHero />

<p class="hero-caption"><code>agents show</code> confirms the registration — <code>source: custom</code> plus the file it loaded — and a one-shot <code>texra run</code> proves the prompts work before you polish the YAML further.</p>

### <wa-icon library="texra" name="shield"></wa-icon> Strict XML Extraction

TeXRA expects the model's output to use properly closed XML tags. For agents producing multiple files, each `<document>` block must include a `name` attribute matching one of the filenames from the UI. If tags are mismatched or a filename doesn't match, extraction fails and no files are saved — check the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs for details.

For more examples and advanced options, browse the built-in agent definitions through the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
