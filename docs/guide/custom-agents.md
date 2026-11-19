# Custom agents

<script setup>
import ToolCategoriesHero from '../.vitepress/components/ToolCategoriesHero.vue';
</script>

Every agent in TeXRA is a YAML file: a chat persona with a prompt and a list of tools. You can copy and edit any built-in agent or write a new one from scratch—for example, to check derivations against your group's conventions or to manage a bibliography.

This guide shows how to create and test your own `.yaml` agent definitions.

::: info Agent fundamentals
Before creating a custom agent, it helps to understand the underlying concepts:

- <wa-icon library="texra" name="symbol-structure"></wa-icon> **Agent architecture and execution flow**: how chats and programs run. Read the [Agent architecture](./agent-architecture.md) guide.
- <wa-icon library="texra" name="sparkle"></wa-icon> **Built-in agents**: the standard agents TeXRA provides, useful as examples. Read the [Built-in agent reference](./built-in-agents.md).
- <wa-icon library="texra" name="dashboard"></wa-icon> **Agents tab**: browse and manage agent files from the **Agents** tab (<wa-icon library="texra" name="robot"></wa-icon>) in the TeXRA Settings.
:::

## <wa-icon library="texra" name="new-file"></wa-icon> Creating a custom agent file

### <wa-icon library="texra" name="folder-opened"></wa-icon> Step 1: locate or configure the custom agents directory

Custom agents live in a dedicated directory that TeXRA prepares for you.

1. **Find the default folder**: TeXRA seeds a `custom_agents` directory inside its global storage. Open the **Agents** tab (<wa-icon library="texra" name="robot"></wa-icon>) in the TeXRA Settings and expand **Custom agent folder** at the bottom of the **Library** section to see its location.
2. **Override (optional)**: to manage agents elsewhere, select **Change folder** in that **Custom agent folder** row to pick a new folder (**Use default folder** switches back). TeXRA creates that directory if needed and uses it instead of the default.

### <wa-icon library="texra" name="wand"></wa-icon> Automatic creation

To have TeXRA draft an agent for you, chat with the built-in [`creator`](./built-in-agents.md#creator) agent and describe the behavior you want. It studies the existing agents, writes the YAML into your custom agents folder (you approve the write like any other edit), and can test the new agent before handing it over.

### <wa-icon library="texra" name="file-add"></wa-icon> Step 2: create a new YAML file

1. In the **Agents** tab, select **New agent** to create a new agent YAML file from a template in your custom agents directory.
2. Alternatively, select the folder icon (<wa-icon library="texra" name="folder-open"></wa-icon>, **Open custom agents folder**) in the **Custom agent folder** row to open the directory and create a `.yaml` file manually.
3. Choose a descriptive file name ending with `.yaml` (for example `literature_review_generator.yaml`).

### <wa-icon library="texra" name="edit"></wa-icon> Step 3: define the agent

Open the new `.yaml` file. A starter template is already inserted. An agent file has five fields:

```yaml
name: notation_checker # Letters, digits, underscores, or dashes; starts with a letter or digit.
description: Checks notation across the project's documents.
temperature: 0.1 # Optional, 0 to 1 (default 1.0). Lower is more deterministic.
tools: # The tools the agent may call.
  - read_file
  - edit_file
  - glob
  - grep

prompt: |
  # The system prompt: the AI's role, core instructions and constraints.
  [Define the AI's role and core instructions]
```

The file is flat and strict: a key TeXRA does not know is refused, and the
older nested `settings:` / `prompts:` layout is not read. There is no `model`
field; you choose the model when you run the agent.

::: warning No `task` block
Earlier versions let an agent file define a document task in a `task:` block
(`prefix`, `requests`, `files`, `outputs` and template variables). That block
no longer exists, and a file that has it is refused as an unrecognized key.
Documents are revised by the built-in [programs](./built-in-agents.md#programs)
instead.
:::

### <wa-icon library="texra" name="link"></wa-icon> Custom document workflows

User-defined programs are not available yet. To get a custom document workflow:

- **Write the request in the instruction.** The programs take their scope and point of view from the instruction, so "read as a referee for a physics journal and mark every unsupported claim" needs no new agent, only `annotate` with that sentence.
- **Ask an agent to chain programs.** A program's result lists the files it wrote, so an agent can pass them to the next program in the same session, for example `annotate`, then `apply`. Read [Multi-agent workflows](./multi-agent-workflows.md).
- **Put project conventions in `AGENTS.md`.** Notation rules, journal style and anything else every run should follow belong in the project's `AGENTS.md`, not in an agent file.

### <wa-icon library="texra" name="tools"></wa-icon> Agents with tools

An agent works in a chat: it holds a conversation and calls tools to read and edit files, run commands, search the web, and look up papers.

List the tools to grant under `tools:`. What you type in the composer is sent directly as the user message. TeXRA groups tools by plugin (listed on **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>)); each chip below is a tool name you can place in `tools:`:

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

### <wa-icon library="texra" name="save"></wa-icon> Step 4: save and run

1. Save your `.yaml` file.
2. TeXRA watches the custom agents directory, so your new agent appears in the **Agent** dropdown (<wa-icon library="texra" name="robot"></wa-icon>) of the TeXRA UI. No window reload needed.

From a terminal, verify the agent registered, then smoke-test it in one go:

```bash
texra agents show bib_helper
texra run bib_helper --instruction "List the entries in refs.bib that main.tex never cites."
```

`agents show` prints the agent's name, its source (`custom`) and the file it loaded.

### <wa-icon library="texra" name="sync"></wa-icon> Customized built-in agents and updates

Built-in agents ship with TeXRA and update when TeXRA does. A custom agent with the same name as a built-in overrides it. **Customize** in the Agents tab (or `texra agents customize <name>`) copies the built-in into your custom agents folder and records which version it copied in a `basedOn:` line at the end of the file.

When an update changes that built-in, the Agents tab marks your copy and offers **View built-in**, **Reset to built-in** (deletes your copy so the new version is used), and **Keep mine** (keeps your copy and dismisses the notice). In the terminal, `texra agents list` and `texra agents show` print the same notice, and `texra agents reset <name>` or `texra agents keep <name>` resolve it. An agent you wrote yourself under a built-in's name has no `basedOn:` line and is never flagged.

For more examples, browse the built-in agent definitions through the **Agents** tab (<wa-icon library="texra" name="robot"></wa-icon>) in the TeXRA Settings.
