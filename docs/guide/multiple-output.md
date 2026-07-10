<script setup>
import MultiOutputMatchHero from '../.vitepress/components/MultiOutputMatchHero.vue'
import MultiInputOrderHero from '../.vitepress/components/MultiInputOrderHero.vue'
import MultiOutputModesHero from '../.vitepress/components/MultiOutputModesHero.vue'
import CliRunHero from '../.vitepress/components/CliRunHero.vue'
</script>

# Handling Multiple Files (Inputs & Outputs)

TeXRA excels at managing complex academic projects often split across multiple files, like a paper with several chapters or appendices. This guide explains how to work with multiple input files and how agents can generate multiple, distinct output files in a single run.

## Why Use Multiple Files?

Working with multiple files is often necessary when:

- Your source document is split (e.g., `chapter1.tex`, `chapter2.tex`, `appendixA.tex`).
- You need to apply consistent changes (like polishing or correcting) across related documents.
- You only want an agent to modify specific parts (e.g., only update `chapter2.tex` and `appendixA.tex` based on the full context).
- An agent needs to generate distinct outputs based on a single input (less common, but possible).

## UI for Multiple Files

The TeXRA UI provides dedicated sections for managing multiple input files.

- **Input Files**: Each Input row is an ordered list — use **Add files** (<wa-icon library="texra" name="add"></wa-icon>), **Add opened files** (<wa-icon library="texra" name="folder-opened"></wa-icon>), or drag-and-drop to append sources. They are concatenated and provided as context to the selected agent. For editing agents, the expected output filenames are the selected input filenames in the same order.
- **Fixed Outputs**: Agents that create files with names not determined by the inputs declare those filenames in `settings.defaultOutputFiles`.

<MultiInputOrderHero />

<p class="hero-caption">The Input group is an ordered list — drag to reorder. For editing agents the row order is the output order, and each input filename is reused as its output filename.</p>

Multi-file runs are not webview-only. In the terminal, repeated `--input`
flags are the same ordered Input list, and `--output-dir` collects the
per-file artifacts:

<CliRunHero
  command="texra run polish --input chapter1.tex --input chapter2.tex --output-dir polished"
  :rounds="[
    { label: 'r0 — draft revision', state: 'done' },
    { label: 'r1 — critique and revise', state: 'done' },
  ]"
  :outputs="['polished/chapter1.tex', 'polished/chapter2.tex']"
  note="One copied path per output — relative document paths are preserved under the directory."
/>

_(See [File Management](./file-management.md) for general UI controls.)_

## How It Works: Agent Input

When you provide multiple input files, TeXRA typically combines their content (often wrapping each in `<document name=\"...\">` tags within a parent `<documents>` tag) and includes it in the prompt sent to the selected agent. The agent receives the combined context to inform its processing.

## How It Works: Agent Output & Extraction

This is the crucial part for generating multiple distinct files:

1. **TeXRA Determines Outputs:** Editing agents use the selected input filenames as the output filenames. Generator agents can declare fixed filenames through `settings.defaultOutputFiles`.
2. **Agent Generates Structured XML:** The selected agent must be designed (through its `prompts`) to produce a _single XML response_ containing separate blocks for each intended output file, using a structure like this:

   ```xml
   <documents>  <!-- fixed protocol container, not agent-configurable -->
     <document name="chapter2.tex">
       % ... content for the first output file ...
     </document>
     <document name="appendixA.tex">
       % ... content for the second output file ...
     </document>
     ...
   </documents>
   ```

3. **TeXRA Extracts:** The TeXRA backend parses this XML response. It looks for `<document>` tags with a `name` attribute that **exactly matches** one of the expected output filenames.
4. **Files Saved:** For each matching tag found, TeXRA extracts the content within that tag and saves it to the corresponding filename. If the agent's response doesn't include a `<document>` tag with a name matching one you specified, that file will not be created or updated.

<MultiOutputMatchHero />

<p class="hero-caption">Each <code>&lt;document name="…"&gt;</code> block is matched by name against the expected output filenames — matches are saved, a block with no matching name is skipped.</p>

**Key Point:** The agent must be explicitly instructed via its prompts to
generate the `<document name=\"...\">` structure matching the output filenames
provided through `INPUT_FILES` for editing agents, or `OUTPUT_FILES` for agents
that declare generated output filenames.

## Tracking Multi-Output Runs

TeXRA uses the selected input filenames as the output filenames for ordinary
editing agents. Agents that generate files with fixed names can declare
`defaultOutputFiles`; those names are exposed as `OUTPUT_FILES`. Prompt rendering
and output extraction depend on these filename lists, not on a separate YAML flag
or a `_multiple` filename convention.

<MultiOutputModesHero />

<p class="hero-caption">Two ways output filenames are determined: editing agents reuse the selected <code>INPUT_FILES</code>, while generator agents emit the fixed names declared in <code>defaultOutputFiles</code> (exposed as <code>OUTPUT_FILES</code>).</p>

### Declaring multi-output agents in YAML

Custom workflow agents can advertise that they expect multiple outputs by
setting `settings.defaultOutputFiles` to the expected filenames. This gives
prompts a fixed `OUTPUT_FILES` list when the filenames are not the input
filenames.

```yaml
name: my_agent
settings:
  agentCategory: workflow
  defaultOutputFiles:
    - paper_section.tex
    - appendix.tex
```

The legacy `useMultipleOutputs` and `isMultipleOutput` YAML fields are no longer
part of the current agent settings schema. Update existing YAML files to declare
`defaultOutputFiles` instead.

## Example: Multiple-Output Agent Prompts

Workflow edit prompts can use `INPUT_FILES` to request and format
multiple outputs within the `<documents>` tag. `INPUT_FILES` is an array
of selected input filenames, so templates should iterate over it. Use
`{{ INPUT_FILES | join(", ") }}` when the prompt needs a readable list.

```yaml
# Inside a workflow agent's userRequest prompt:
# ... instructions ...
Output one updated document for each input file, using the matching input
filename as the document name.

# Use the following format:
<documents>
{% for output in INPUT_FILES %}
<document name="{{ output }}">
% UPDATED_CONTENT_FOR_{{ output }}
</document>
{% endfor %}
</documents>
```

For agents with `settings.defaultOutputFiles`, iterate over `OUTPUT_FILES`
instead.

This instructs the model to generate the necessary XML structure that TeXRA can parse.

## When to Use

- Applying consistent edits (e.g., `polish`, `correct`) across multiple related `.tex` files.
- Tasks where an agent naturally produces distinct outputs (though less common than editing existing files).
- Targeting agent modifications to specific files within a larger project.

## Next Steps

- [Custom Agents](./custom-agents.md): Learn how to design prompts for agents handling multiple outputs.
- [File Management](./file-management.md): Review the file selection UI in detail.
- [Agent Architecture](./agent-architecture.md): Understand the overall agent execution flow.

## Output Naming

By default, TeXRA uses the selected input filenames as the output filenames.
Agents that write fixed new files should declare `settings.defaultOutputFiles`.
Editing prompts should reference `INPUT_FILES`; generated-output prompts should
reference `OUTPUT_FILES` so the model emits matching `<document name="...">`
tags.
