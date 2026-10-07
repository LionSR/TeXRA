# Custom agents

<script setup>
import ToolCategoriesHero from '../.vitepress/components/ToolCategoriesHero.vue';
import AgentAnatomyHero from '../.vitepress/components/AgentAnatomyHero.vue';
import OutputMappingHero from '../.vitepress/components/OutputMappingHero.vue';
import CliAgentShowHero from '../.vitepress/components/CliAgentShowHero.vue';
</script>

Every research discipline develops distinct methodological conventions. Whether you need an agent to verify every algebraic step in a derivation against domain invariants, standardize notation across an entire project, or enforce strict formatting for journal submissions, custom agents allow you to formalize these workflows in declarative YAML files.

This guide walks you through creating your own agent definition files (`.yaml`) so TeXRA does what your research needs. No coding required.

::: info Agent fundamentals
Before creating a custom agent, it helps to understand the underlying concepts:

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Agent architecture and execution flow**: the `.yaml` structure, settings, prompts, and how agents run. Read the [Document tasks: how they work](./agent-architecture.md) guide.
- <wa-icon library="texra" name="sparkle"></wa-icon> **Built-in agents**: the standard agents TeXRA provides, useful as examples. Read the [Built-in agent reference](./built-in-agents.md).
- <wa-icon library="texra" name="dashboard"></wa-icon> **Agents tab**: browse and manage agent files from the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Settings.
  :::

## <wa-icon library="texra" name="library"></wa-icon> Reference agents

TeXRA includes ready-made reference agents you can use as starting points. Treat them as recipes: copy one into your custom agents directory, adjust it, and you have a new agent in minutes. Examples range from content-enhancement workflows to notation standardizers and multi-agent orchestrators. Each agent handles one input or several through the fixed `<documents>` container and emits one `<document name="...">` per input.

## <wa-icon library="texra" name="new-file"></wa-icon> Creating a custom agent file

Follow these steps to create a new custom agent.

### <wa-icon library="texra" name="folder-opened"></wa-icon> Step 1: locate or configure the custom agents directory

Custom agents live in a dedicated directory that TeXRA prepares for you.

1. **Find the default folder**: TeXRA seeds a `custom_agents` directory inside its global storage. Open the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Settings to see its location.
2. **Override (optional)**: to manage agents elsewhere, open the **Agents** tab and select **Change** (<wa-icon library="texra" name="edit"></wa-icon>) in the directory info bar to pick a new folder. TeXRA creates that directory if needed and uses it instead of the default.

### <wa-icon library="texra" name="wand"></wa-icon> Automatic creation

To have TeXRA draft an agent for you, chat with the built-in [`creator`](./built-in-agents.md#creator) agent and describe the behavior you want. It studies the existing agents, writes the YAML into your custom agents folder (you approve the write like any other edit), and can test the new agent before handing it over.

### <wa-icon library="texra" name="file-add"></wa-icon> Step 2: create a new YAML file

1. In the **Agents** tab, select **New chat agent** or **New document task** (<wa-icon library="texra" name="file-circle-plus"></wa-icon>) to create a new agent YAML file from a template in your custom agents directory.
2. Alternatively, select the folder icon (<wa-icon library="texra" name="folder-open"></wa-icon>, **Open custom agents folder**) in the directory info bar to open the directory and create a `.yaml` file manually.
3. Choose a descriptive name using underscores and ending with `.yaml` (for example `literature_review_generator.yaml`).

### <wa-icon library="texra" name="edit"></wa-icon> Step 3: define the agent

Open the new `.yaml` file. A starter template is already inserted. An agent is three labelled sections plus one mapping to keep in mind:

<AgentAnatomyHero />

<p class="hero-caption">An agent file is its identity (<code>name</code>, <code>description</code>) + a persona (<code>prompt</code>, <code>temperature</code>) + a <code>task</code> block; the <code>task.requests</code> list maps position-by-position onto revisions (<code>requests[0]</code> is Revision 1, <code>requests[1]</code> Revision 2).</p>

Customize it to define your agent's structure. These are the key fields:

```yaml
name: notation_checker # Lowercase letters, underscores, or dashes.
description: Standardizes notation across the selected documents.

# --- Persona ---
temperature: 0.1 # Optional, 0 to 1 (default 1.0). Lower is more deterministic.

prompt: |
  # The system prompt: the AI's role, core instructions, constraints, overall persona.
  # Sent once at the beginning (for supported models).
  [Define the AI's role and core instructions]

# --- Document task ---
# A `task` block lets this agent also run as a document task. Without it,
# the agent only chats (see below). A file with `task` cannot also list `tools`.
task:
  rewrite: true # Edit the input documents (true, the default) or write new documents (false).

  # File Handling (Optional - Advanced)
  # files:
  #   STYLE_GUIDE: styles/internal_style.sty # Map variable names to files the agent bundles, relative to its YAML file location. Workspace files are attached per run as context files instead.
  # outputs: # Used when the agent writes new files with fixed names.
  #   - 'introduction.tex'
  #   - 'methods.tex'

  prefix: |
    # Provides introductory text, main context (input files, user instruction).
    # Variables like `{{ INPUT_CONTENT }}`, `{{ INSTRUCTION }}`, `{{ ALL_CONTEXTS }}` are substituted here.
    [Define context, instructions, and input variables like `{{ INPUT_CONTENT }}`]

  requests:
    - |
      # The prompt for the AI's first revision.
      # Often includes guidance for thinking (<scratchpad>) and the fixed <documents> output structure.
      [Define the initial task prompt, potentially including scratchpad guidance]
    - |
      # Optional follow-up prompt for a reflection revision.
      # Each entry is one revision: add or remove entries to control how many run.
      [Define how the model should critique or iterate on its previous output]
```

The file is flat and strict: a key TeXRA does not know is refused, and the
older nested `settings:` / `prompts:` layout is not read. There is no `model`
field; you choose the model when you run the agent.

> **Reflection tips:** TeXRA takes the first `requests` entry as the initial
> request and each remaining entry as one reflection prompt, in order. The
> number of entries is the number of revisions.

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
  This is only populated for agents that set `task.outputs` or receive an
  explicit generated output list.

**Custom variables (from `task.files`):**

- Each file bound in `task.files` is available as `{{ VARNAME_FILE }}` (its path) and `{{ VARNAME_CONTENT }}` (its text); a binding `TEMPLATE: template.tex` gives `{{ TEMPLATE_CONTENT }}`.
- When agents finish, TeXRA captures detected XML segments so orchestrated workflows can reuse them without going through the file picker again (details below).

**Example usage in `task.prefix`:**

```yaml
task:
  prefix: |
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

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Architecture overview:** For the execution flow and how prompts and settings interact, read the [Document tasks: how they work](./agent-architecture.md) guide.
- <wa-icon library="texra" name="type-hierarchy"></wa-icon> **Start from a copy:** Customizing a related built-in agent (for example `correct` or `polish`) gives you a full copy to edit, which saves effort.
- <wa-icon library="texra" name="files"></wa-icon> **Multiple outputs:** If your agent needs to generate multiple distinct files, make sure your prompts generate the required XML structure. Read the [Handling multiple files](./multiple-output.md) guide.
- <wa-icon library="texra" name="rocket"></wa-icon> **Start simple:** Begin with basic settings and prompts and add complexity incrementally.
- <wa-icon library="texra" name="debug-alt"></wa-icon> **Test iteratively:** Test often and review logs in the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>).

### <wa-icon library="texra" name="link"></wa-icon> Chaining agents together

After a document task finishes, its result lists the output files, so follow-up steps can reuse them without another trip through the file picker. This is how multi-stage pipelines work: for example, an orchestrator agent can run `polish` with the `document_task` tool, then hand the result to a `correct` task, all in one session.

You do not need to configure this yourself; it happens when an agent definition includes orchestration prompts. The reference agents contain working examples.

### <wa-icon library="texra" name="tools"></wa-icon> Agents with tools

An agent without a `task` block works in a chat: instead of producing a single polished file, they hold a conversation and take actions on your behalf, such as reading and editing files, searching the web, and looking up papers.

**Typical user story:** You are writing up results for a conference submission and realize you need three new BibTeX entries, a TikZ architecture diagram, and a consistency pass across four `.tex` files. Rather than juggling browser tabs and terminal windows, you open a `research` agent (<wa-icon library="texra" name="sparkle"></wa-icon>) and describe what you need. The agent reads your project, searches arXiv for the missing references, drafts the TikZ code, and edits the files, all in one session.

To create your own agent with tools, leave out the `task` block and list the tools you want to grant. Such an agent has no request template: what you type is sent as the user message. TeXRA groups tools by the plugin that adds them (listed on **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>)). Each chip below is a token you can put straight into your `tools:` array:

<ToolCategoriesHero />

<p class="hero-caption">The grantable tool categories; every chip is a name you can list verbatim in your agent's <code>tools:</code> array.</p>

For the exact tool names to list in your YAML, browse any of the built-in agents with tools (like `research`, `review`, `lean`, or `numerics`) in the **Agents** tab. Their `tools:` array shows which tools are wired up.

Example skeleton:

```yaml
name: bib_helper
description: Finds references and edits the bibliography.
tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
  - web_search

prompt: |
  [Define the agent's role and how it should use its tools]
```

The ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs every tool call and its result, so you can always see what the agent is doing.

### <wa-icon library="texra" name="files"></wa-icon> Example: multiple output agent

If your workflow requires several output files, your agent must structure its
response using the appropriate filename list. Below is a simplified template
for a document task that writes two generated output files:

```yaml
name: intro_and_conclusion
description: Writes an introduction and a conclusion.
task:
  rewrite: false
  outputs:
    - introduction.tex
    - conclusion.tex
  requests:
    - |
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
filename from the selected input list or from `task.outputs`:

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

### <wa-icon library="texra" name="sync"></wa-icon> Customized built-in agents and updates

Built-in agents ship with TeXRA and update when TeXRA does. A custom agent with the same name as a built-in overrides it. **Customize** in the Agents tab (or `texra agents customize <name>`) copies the built-in into your custom agents folder and records which version it copied in a `basedOn:` line at the end of the file.

When an update changes that built-in, the Agents tab marks your copy and offers **View built-in**, **Reset to built-in** (deletes your copy so the new version is used), and **Keep mine** (keeps your copy and dismisses the notice). In the terminal, `texra agents list` and `texra agents show` print the same notice, and `texra agents reset <name>` or `texra agents keep <name>` settle it. An agent you wrote yourself under a built-in's name has no `basedOn:` line and is never flagged.

### <wa-icon library="texra" name="shield"></wa-icon> Strict XML extraction

TeXRA expects the model's output to use properly closed XML tags. For agents producing multiple files, each `<document>` block must include a `name` attribute matching one of the filenames from the UI. If tags are mismatched or a filename does not match, extraction fails and no files are saved. Check the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) logs for details.

For more examples and advanced options, browse the built-in agent definitions through the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>) in the TeXRA Settings.
