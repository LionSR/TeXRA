<script setup>
import AgentYamlHero from '../.vitepress/components/AgentYamlHero.vue'
import RoundOutputTree from '../.vitepress/components/RoundOutputTree.vue'
import AgentModesCompare from '../.vitepress/components/AgentModesCompare.vue'
import CliRunHero from '../.vitepress/components/CliRunHero.vue'
</script>

# Document tasks: how they work

Whenever you run an agent's document task in TeXRA, the runtime orchestrates your input files, context references, and instructions into a structured prompt, calls the agent once per revision, and yields versioned diffs. This page examines the architectural machinery underneath: YAML configurations, prompt compilation, execution stages, and reflection cycles.

::: tip When to run a document task
Document tasks are built for **deep, single-shot thinking**: deriving or checking equations step by step, rewriting a whole section, converting a paper to slides, or merging edits. They plan in a `<scratchpad>`, produce a full XML-wrapped output, and optionally reflect on it in another revision, so runs with frontier reasoning models can take **10–30 minutes** to finish.

If you want a faster turnaround (quick polishes, small corrections), pick a **smaller or faster model** in the model dropdown: output quality drops somewhat, but wall-clock time drops a lot. For short, conversational edits or read-only questions, chat with an agent (`assistant`, `research`, `review`) instead: a chat streams back in seconds and skips the document pipeline. For a problem too big for one agent, a team lead can run several document tasks at once; read [Multi-agent workflows](./multi-agent-workflows.md).
:::

Every agent can chat. Only an agent whose file has a `task` block can also run a document task; the agent picker lists those under **Document task**.

<AgentModesCompare />
<p class="hero-caption">A document task reasons once per revision and writes a versioned, diffable file; a chat converses and calls tools turn by turn. This is the first thing to pick for any task. On the CLI, <code>texra run polish --input …</code> runs a document task and <code>texra chat --agent research</code> opens a chat.</p>

## Agent definition files (`.yaml`)

Each agent is defined in a `.yaml` file that tells TeXRA what to say to the AI model and how to handle the response. Browse and manage these files from the **Agents** tab in the TeXRA Settings, or create your own (see [Custom agents](./custom-agents.md)).

## Understanding the YAML structure

These `.yaml` files are flat. An agent with a document task has two main parts:

<AgentYamlHero />
<p class="hero-caption">Top-level fields set the persona (<code>prompt</code>, <code>temperature</code>); a <code>task</code> block holds the document templates, and its <code>requests</code> list has one entry per revision.</p>

1.  **The persona** (top-level fields): how the model behaves.
    - `prompt`: The system prompt. Sets the overall role and high-level instructions for the LLM.
    - `temperature`, `inherits`, and (for agents without a `task` block only) `tools`. See [Custom agents](./custom-agents.md) for details.
2.  **`task`**: Present only on agents with a document task. Text templates that TeXRA fills with your context (input files, instruction) to guide the LLM at each stage, plus output settings:
    - `prefix`: Provides the main context, including your input file(s) (available as `{{ INPUT_CONTENT }}`) and the instruction you typed in the UI (available as `{{ INSTRUCTION }}`).
    - `requests`: A list with one entry per revision. The first entry asks the LLM to perform the initial task (the first revision). It often instructs the LLM to think within `<scratchpad>` tags and then output the main content wrapped in the fixed `<documents>` container, with one `<document name="...">...</document>` entry per output file. Each further entry drives one reflection revision.
    - `rewrite`, `outputs`, and `files`: whether the agent edits its inputs or writes new documents, the default output filenames, and template files kept beside the YAML.

_(Prompts use Nunjucks templating (Jinja2-style syntax). For the list of available variables such as `{{ INPUT_CONTENT }}` and how to use them, read the [Custom agents](./custom-agents.md) guide.)_

::: tip Transparency & Customization
These prompts (`prompt`, `task.prefix`, and `task.requests`) are TeXRA's structured approach to guiding the LLM. Because the system is template-based, an agent's behavior is transparent and customizable through its `.yaml` file, not hidden in a black box.
:::

## Basic execution flow

When you launch a document task in the TeXRA UI, TeXRA runs the document recipe: for each revision it builds the prompt from the agent's `task` templates and your inputs, calls the agent once with it, and extracts, compiles and diffs the documents in the reply:

```mermaid
sequenceDiagram
    participant User
    participant TeXRA UI
    participant Agent Backend
    participant LLM API

    User->>TeXRA UI: Selects files, agent, instruction, model
    User->>TeXRA UI: Launches the document task
    TeXRA UI->>Agent Backend: run(config)
    Agent Backend->>Agent Backend: Initialize (Load agent definition, read files)
    Note over Agent Backend: Revision prompt from task.prefix + task.requests + User Input; system prompt from prompt
    Agent Backend->>LLM API: Create Response (Revision 1 Prompt)
    Note over LLM API: Processes request based on prompts
    LLM API-->>Agent Backend: Response (Text + Usage + StopReason)
    Agent Backend->>Agent Backend: Process Response (Save r0/output.* output)
    Agent Backend-->>TeXRA UI: Update ProgressBoard / Signal Completion
```

**Key stages:**

1.  **Initialization:** TeXRA loads the agent definition and reads the files you selected.
2.  **Prompt construction:** TeXRA renders `task.prefix` (filled with your files and instruction) and the revision's `task.requests` entry into one message, and calls the agent with it; the agent's `prompt` is the system prompt.
3.  **LLM interaction (first revision):** TeXRA sends the prompt to the selected LLM API. The LLM generates a response, typically including reasoning (`<scratchpad>`) and the final answer wrapped in the fixed `<documents><document name="...">...</document></documents>` container.
4.  **Processing:** TeXRA saves the raw LLM response (as `r{n}/output.xml`, where `r0/` is the first revision). It then parses this file and extracts the content of each `<document name="...">` entry into its own file under the revision's directory in run storage, named after that entry's `name` (a polish run on `paper.tex` produces `r0/paper.tex` for the first revision and `r1/paper.tex` for the second; a `<document name="chapters/main.tex">` entry lands as `r{n}/chapters/main.tex`; only the raw response uses the fixed `output.xml` stem, and a document literally named `output.tex` is renamed `output_extracted.tex` so it cannot clobber it). You can follow this in the [ProgressBoard](./progress-board.md), where each revision's agent call shows as a child run. For LaTeX files, TeXRA compiles each output and can also generate a `latexdiff` file comparing it to its input. When the last revision is done, TeXRA proposes one revised document per input file for you to accept. Read the [LaTeX Diff guide](./latex-diff.md) for details.

The UI is not the only way in. The same
load-definition → prompt → revisions → save-to-run-storage pipeline runs
headlessly from the terminal:

<CliRunHero
  command="texra run polish --input paper.tex --output paper.polished.tex"
  :rounds="[
    { label: 'Revision 1: draft', state: 'done' },
    { label: 'Revision 2: reflection pass', state: 'done' },
  ]"
  :outputs="['paper.polished.tex']"
  note="Same agent definition, same revisions, same run storage: no UI attached."
/>

Each revision lands in its own folder under run storage:

<RoundOutputTree />
<p class="hero-caption">Every revision saves the raw <code>output.xml</code>, one extracted file per <code>&lt;document name&gt;</code> (named after the input file, for example <code>paper.tex</code>), and an optional <code>latexdiff</code> PDF. <code>r0/</code> is the first revision (the draft); <code>r1/</code> and later are reflection passes.</p>

**Output limit:** If the LLM response is cut off by the model's max output tokens before the closing `</documents>` tag, TeXRA keeps what the model wrote as that revision's output and warns in the transcript that it may be incomplete. Raise the model's max output tokens if a long document gets cut off.

### What goes into the prompt

Each revision's prompt is one message holding the conversation so far: `task.prefix` with the content you selected, then each earlier request with the reply it got, then this revision's request (with the compile errors that failed the last revision, when failed compiles are rejected). If **Attach TeX Count** is on, that information is included too. Figures and audio files are sent alongside the text for models that support them. The model then reasons through the task and produces its output.

**Reflection revisions:**

The number of revisions is the number of `task.requests` entries. An agent with two entries runs a first revision plus one reflection; an agent with one entry runs only the first, as `correct` and `merge` do. After the first revision completes, each additional one works like this:

1.  **Reflection prompt:** TeXRA renders the reflection template from the next `task.requests` entry to ask the LLM to critique and improve its earlier output (included in the revision prompt).
2.  **LLM interaction (second revision):** The LLM generates a revised response.
3.  **Processing:** TeXRA saves the refined output to a separate revision path (`r{n}/<name>`, e.g. `r1/paper.tex` for the first reflection, `r2/paper.tex` for the next).

Control how many revisions run by editing the agent YAML: add or remove entries in `task.requests`. A run ends earlier only on failure or cancellation.

**Critic review (opt-in):** Launched with reflection on (`texra run <agent> --reflect` on the CLI, or `reflect: true` on a lead's `document_task` call), a document task has the bundled `critic` agent review every revision but the last. After the revision is compiled and diffed, the critic reads the requests so far, the diff of each output against the document the task started from, and the compile result, and answers with grounded corrections, each tied to a location, plus the single most valuable optional improvement. The next revision's prompt carries that critique in a `<critique>` block. The revision count stays the number of `task.requests` entries; reflection adds one critic call between revisions.

This flow, with optional reflection revisions, lets TeXRA agents perform targeted tasks based on their definitions and your instructions. For examples of built-in agents, read the [Built-in agent reference](./built-in-agents.md).

::: warning Potential XML Issues
Occasionally an LLM generates slightly malformed XML (for example, a missing closing tag), especially for very long or complex outputs. If TeXRA fails to extract content from an agent's raw XML output (any revision's `r{n}/output.xml`, for example `r0/output.xml`), open the `.xml` file and correct the structural error (such as adding a missing `</document>` tag); TeXRA can then process it. Read the [Troubleshooting guide](./troubleshooting.md#output-file-corruption) for details.
:::

### Reflection

After the first revision (`r0/`), agents that define a reflection request evaluate and refine their work in the second (`r1/`):

<div class="reflection-pdf-viewer">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Original vs. revision 1</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Original vs. revision 2</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Revision 1 vs. revision 2</button>
  </div>
  <iframe src="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf" id="pdf-frame" class="reflection-pdf-frame"></iframe>
  <a href="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf" target="_blank" id="pdf-link" class="reflection-pdf-link">View full example</a>
</div>

<div class="reflection-legend">
  <div class="legend-item"><span class="del">Red strikethrough</span>: first-revision content revised in the second</div>
  <div class="legend-item"><span class="add">Blue underlined</span>: New/improved content added in the second revision</div>
</div>

<style>
.reflection-pdf-viewer {
  position: relative;
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  margin: 1rem 0;
}
.reflection-pdf-frame {
  width: 100%;
  height: 350px;
  border: none;
}
.reflection-pdf-link {
  position: absolute;
  top: 10px;
  right: 10px;
  color: white;
  padding: 5px 10px;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.85rem;
}
.reflection-pdf-link:hover {
  background: var(--vp-c-brand);
}
.reflection-legend {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  padding: 0.75rem;
  background-color: var(--vp-c-bg-soft);
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.reflection-legend .del {
  color: #ff5252;
  text-decoration: line-through;
  font-weight: 500;
}
.reflection-legend .add {
  color: #0066cc;
  text-decoration: underline;
  font-weight: 500;
}
.pdf-tabs {
  display: flex;
  border-bottom: 1px solid var(--vp-c-divider);
  margin-bottom: 0.5rem;
}
.pdf-tab {
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  font-size: 0.9rem;
  text-decoration: none;
  color: inherit;
  background: none;
  font-family: inherit;
  text-align: center;
}
.pdf-tab:hover {
  background-color: var(--vp-c-bg-soft);
}
.pdf-tab.active {
  background-color: var(--vp-c-bg-soft);
  border-color: var(--vp-c-divider);
  border-bottom-color: var(--vp-c-bg-soft);
  color: var(--vp-c-brand);
  font-weight: 500;
  margin-bottom: -1px;
}
</style>
