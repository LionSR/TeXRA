# Custom agents

<script setup>
import ToolCategoriesHero from '../.vitepress/components/ToolCategoriesHero.vue';
import AgentAnatomyHero from '../.vitepress/components/AgentAnatomyHero.vue';
import OutputMappingHero from '../.vitepress/components/OutputMappingHero.vue';
import CliAgentShowHero from '../.vitepress/components/CliAgentShowHero.vue';
</script>

Every research group has its own recurring tasks. Maybe you want an agent that checks every derivation in a section against a fixed set of conventions, one that standardizes notation across a manuscript, or a "rewrite the abstract for a Nature-style letter" pass. Custom agents let you encode these workflows once and reuse them with one selection.

This guide walks you through creating your own agent definition files (`.yaml`) so TeXRA does what your research needs. No coding required.

::: info Agent fundamentals
Before creating a custom agent, it helps to understand the underlying concepts:

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Agent architecture and execution flow**: the `.yaml` structure, settings, prompts, and how agents run. Read the [Workflow agents: how they work](./agent-architecture.md) guide.
- <wa-icon library="texra" name="sparkle"></wa-icon> **Built-in agents**: the standard agents TeXRA provides, useful as examples and as inheritance parents. Read the [Built-in agent reference](./built-in-agents.md).
- <wa-icon library="texra" name="dashboard"></wa-icon> **Agents tab**: browse and manage agent files from the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
  :::

## <wa-icon library="texra" name="library"></wa-icon> Reference agents

TeXRA includes ready-made reference agents you can use as starting points. Treat them as recipes: copy one into your custom agents directory, adjust it, and you have a new agent in minutes. Examples range from content-enhancement workflows to notation standardizers and multi-agent orchestrators. Each agent handles one input or several through the fixed `<documents>` container and emits one `<document name="...">` per input.

## <wa-icon library="texra" name="new-file"></wa-icon> Creating a custom agent file

Follow these steps to create a new custom agent.

### <wa-icon library="texra" name="folder-opened"></wa-icon> Step 1: locate or configure the custom agents directory

Custom agents live in a dedicated directory that TeXRA prepares for you.

1. **Find the default folder**: TeXRA seeds a `custom_agents` directory inside its global storage. Open the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard to see its location.
2. **Override (optional)**: to manage agents elsewhere, open the **Agents** tab and select **Change** (<wa-icon library="texra" name="edit"></wa-icon>) in the directory info bar to pick a new folder. TeXRA creates that directory if needed and uses it instead of the default.

### <wa-icon library="texra" name="wand"></wa-icon> Automatic creation

To have TeXRA draft an agent for you, select **New Agent** (<wa-icon library="texra" name="add"></wa-icon>) in the **Agents** tab. The wizard asks for the agent name and a short description (tool-use agents additionally let you pick the tools to grant). TeXRA sends that information to your configured helper model, which returns the YAML enclosed in `<yaml>...</yaml>` tags. The extension extracts the content between those tags and saves it as a template in your custom agents folder (falling back to a built-in template if generation fails).

### <wa-icon library="texra" name="file-add"></wa-icon> Step 2: create a new YAML file

1. In the **Agents** tab, select **From template** (<wa-icon library="texra" name="file-circle-plus"></wa-icon>) to create a new agent YAML file in your custom agents directory.
2. Alternatively, select the folder icon (<wa-icon library="texra" name="folder-open"></wa-icon>, **Open custom agents folder**) in the directory info bar to open the directory and create a `.yaml` file manually.
3. Choose a descriptive name using underscores and ending with `.yaml` (for example `literature_review_generator.yaml`).

### <wa-icon library="texra" name="edit"></wa-icon> Step 3: define the agent

Open the new `.yaml` file. A starter template is already inserted. An agent is three labelled sections plus one mapping to keep in mind:

<AgentAnatomyHero />

<p class="hero-caption">An agent file is <code>inherits</code> + <code>settings</code> + <code>prompts</code>; the <code>userRequest</code> array maps position-by-position onto rounds (item <code>[0]</code> is Round 0, item <code>[1]</code> the first reflection).</p>

Customize it to define your agent's structure. These are the key fields:

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
  rounds: 2 # Number of passes (Round 0 plus reflection rounds). The actual count is max(rounds, number of userRequest entries); a run ends earlier only on failure or cancellation.

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

> **Reflection tips:** When `userRequest` is an array, TeXRA takes the first
> entry as the initial request and treats the remaining entries as reflection
> prompts. If a run requests more reflections than the list provides, the first
> reflection template is reused.

#### <wa-icon library="texra" name="symbol-variable"></wa-icon> Using variables in prompts (Nunjucks templating)

Prompts are processed with the Nunjucks templating engine (Jinja2-style syntax), so you can insert dynamic information with `{{ variable_name }}` syntax. TeXRA provides several built-in variables based on the files and instructions you select in the UI.

This mechanism is sometimes called **Variable Retrieval (VR)**: the extension loads your chosen inputs, references, figures, and any additional context, then exposes them as template variables. For example, the text content of your main file becomes `{{ INPUT_CONTENT }}` and the full list of selected files is available through `{{ ALL_INPUTS }}`. When you run the agent these placeholders are replaced with real data.

<TemplateVarsPalette />

The naming follows one rule: `*_FILE` gives you a path, `*_CONTENT` gives you
that file's text, `ALL_*` bundles every selected file into one
`<document name="...">…</document>` XML string, and `LIST_OF_*` gives the same
set as a comma-separated path list. Media is the exception: `MEDIA_FILE` is a
path, but the media itself is sent to multimodal models separately rather than
inlined as text (read [Working with figures](./working-with-figures.md)).

**Multiple document output:**

- &#123;&#123; INPUT_FILES &#125;&#125;: Array of input filenames. Editing agents
  should iterate over this list and emit one `<document name="...">` block per
  input filename, preserving the input order and names. Use
  `{{ INPUT_FILES | join(", ") }}` for a human-readable list. Read
  [Handling multiple files](./multiple-output.md).
- &#123;&#123; OUTPUT_FILES &#125;&#125;: Array of declared generated output filenames.
  This is only populated for agents that set `defaultOutputFiles` or receive an
  explicit generated output list.

**Custom variables (from `settings`):**

- Files specified in `requiredFilesInternal` are available as `{{ VARNAME_CONTENT }}` (for example `{{ TEMPLATE_CONTENT }}`).
- When agents finish, TeXRA captures detected XML segments so orchestrated workflows can reuse them without going through the file picker again (details below).

**Example usage in `userPrefix`:**

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

**Key considerations:**

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Architecture overview:** For the execution flow and how prompts and settings interact, read the [Workflow agents: how they work](./agent-architecture.md) guide.
- <wa-icon library="texra" name="type-hierarchy"></wa-icon> **Inheritance:** Inheriting from a relevant built-in agent (like `correct` or `polish`) saves effort. Define only the settings and prompts you need to change.
- <wa-icon library="texra" name="files"></wa-icon> **Multiple outputs:** If your agent needs to generate multiple distinct files, make sure your prompts generate the required XML structure. Read the [Handling multiple files](./multiple-output.md) guide.
- <wa-icon library="texra" name="rocket"></wa-icon> **Start simple:** Begin with basic settings and prompts and add complexity incrementally.
- <wa-icon library="texra" name="debug-alt"></wa-icon> **Test iteratively:** Test often and review logs in the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>).

### <wa-icon library="texra" name="link"></wa-icon> Chaining agents together

After a workflow agent finishes, TeXRA captures the output so follow-up steps can reuse it without another trip through the file picker. This is how multi-stage pipelines work: for example, an orchestrator agent can run a `polish` step, then hand the result to a `correct` step, all in one session.

You do not need to configure this yourself; it happens when an agent definition includes orchestration prompts. The reference agents contain working examples.

### <wa-icon library="texra" name="tools"></wa-icon> Tool-use agents

Tool-use agents are interactive: instead of producing a single polished file, they hold a conversation and take actions on your behalf, such as reading and editing files, searching the web, and looking up papers.

**Typical user story:** You are writing up results for a conference submission and realise you need three new BibTeX entries, a TikZ architecture diagram, and a consistency pass across four `.tex` files. Rather than juggling browser tabs and terminal windows, you open a `research` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and describe what you need. The agent reads your project, searches arXiv for the missing references, drafts the TikZ code, and edits the files, all in one session.

To create your own tool-use agent, set `agentCategory: toolUse` and list the tools you want to grant. TeXRA groups tools by category (matching **Dashboard → Tools** <wa-icon library="texra" name="tools"></wa-icon>). Each chip below is a token you can put straight into your `tools:` array:

<ToolCategoriesHero />

<p class="hero-caption">The seven grantable tool categories on <strong>Dashboard → Tools</strong>; every chip is a name you can list verbatim in your agent's <code>tools:</code> array.</p>

For the exact tool names to list in your YAML, browse any of the built-in tool-use agents (like `research`, `review`, `lean`, or `numerics`) in the **Agents** tab. Their `tools:` array shows which tools are wired up.

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

### <wa-icon library="texra" name="files"></wa-icon> Example: multiple output agent

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

Read [Handling multiple files](./multiple-output.md) for more details.

### <wa-icon library="texra" name="save"></wa-icon> Step 4: save and run

1. Save your `.yaml` file.
2. TeXRA watches the custom agents directory, so your new agent appears in the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>) of the TeXRA UI. No window reload needed.

From a terminal the iteration loop is faster, with no window reload needed.
Verify the agent registered, then smoke-test it in one go:

<CliAgentShowHero />

<p class="hero-caption"><code>agents show</code> confirms the registration (<code>source: custom</code> plus the file it loaded), and a one-shot <code>texra run</code> proves the prompts work before you polish the YAML further.</p>

### <wa-icon library="texra" name="shield"></wa-icon> Strict XML extraction

TeXRA expects the model's output to use properly closed XML tags. For agents producing multiple files, each `<document>` block must include a `name` attribute matching one of the filenames from the UI. If tags are mismatched or a filename does not match, extraction fails and no files are saved. Check the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs for details.

For more examples and advanced options, browse the built-in agent definitions through the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Dashboard.
