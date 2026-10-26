<script setup>
import MultiOutputMatchHero from '../.vitepress/components/MultiOutputMatchHero.vue'
import MultiInputOrderHero from '../.vitepress/components/MultiInputOrderHero.vue'
import MultiOutputModesHero from '../.vitepress/components/MultiOutputModesHero.vue'
import CliRunHero from '../.vitepress/components/CliRunHero.vue'
</script>

# Handling multiple files (inputs & outputs)

When a paper is split across several files (`chapter1.tex`, `chapter2.tex`, `appendixA.tex`), a single document task run can read them together and write one revised file per input. Custom document tasks can also generate fixed output files from one or more inputs.

## Why use multiple files?

You need multiple files when:

- Your source document is split (for example `chapter1.tex`, `chapter2.tex`, `appendixA.tex`).
- You want consistent changes (such as polishing or correcting) across related documents.
- You want an agent to modify only specific parts (for example, update only `chapter2.tex` and `appendixA.tex` based on the full context).
- An agent needs to generate distinct outputs from a single input (less common, but possible).

## UI for multiple files

The TeXRA UI provides dedicated sections for managing multiple input files.

- **Input Files**: Each Input row is an ordered list. Use **Add files** (<wa-icon library="texra" name="add"></wa-icon>), **Add opened files as input** (<wa-icon library="texra" name="folder-opened"></wa-icon>), or drag-and-drop to append sources. They are concatenated and provided as context to the selected agent. For editing agents, the expected output filenames are the selected input filenames in the same order.
- **Fixed Outputs**: Agents that create files with names not determined by the inputs declare those filenames in `task.outputs`.

<MultiInputOrderHero />

<p class="hero-caption">The Input group is an ordered list; drag to reorder. For editing agents the row order is the output order, and each input filename is reused as its output filename.</p>

Multi-file runs are not webview-only. In the terminal, repeated `--input`
flags are the same ordered Input list, and `--output-dir` collects the
per-file artifacts:

<CliRunHero
  command="texra run polish --input chapter1.tex --input chapter2.tex --output-dir polished"
  :rounds="[
    { label: 'r0: draft revision', state: 'done' },
    { label: 'r1: critique and revise', state: 'done' },
  ]"
  :outputs="['polished/chapter1.tex', 'polished/chapter2.tex']"
  note="One copied path per output: relative document paths are preserved under the directory."
/>

_(Read the [file management guide](./file-management.md) for general UI controls.)_

## How it works: agent input

When you provide multiple input files, TeXRA typically combines their content (often wrapping each in `<document name=\"...\">` tags within a parent `<documents>` tag) and includes it in the prompt sent to the selected agent. The agent receives the combined context to inform its processing.

## How it works: agent output & extraction

This is the part that matters for generating multiple distinct files:

1. **TeXRA determines outputs:** Editing agents use the selected input filenames as the output filenames. Generator agents can declare fixed filenames through `task.outputs`.
2. **Agent generates structured XML:** The selected agent must be designed (through its `task.requests` prompts) to produce a _single XML response_ containing separate blocks for each intended output file, using a structure like this:

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

3. **TeXRA extracts:** The TeXRA backend parses this XML response. It looks for `<document>` tags with a `name` attribute that **exactly matches** one of the expected output filenames.
4. **Files saved:** For each matching tag found, TeXRA extracts the content within that tag and saves it to the corresponding filename. If the agent's response does not include a `<document>` tag with a name matching one you specified, that file is not created or updated.

<MultiOutputMatchHero />

<p class="hero-caption">Each <code>&lt;document name="…"&gt;</code> block is matched by name against the expected output filenames. Matches are saved; a block with no matching name is skipped.</p>

## Editing vs. fixed outputs in YAML

Output filenames come from one of two lists:

- **Editing agents (`rewrite: true`, default)**: reuse the selected `INPUT_FILES`.
- **Generator agents (`rewrite: false`, `task.outputs`)**: emit the fixed filenames listed in `task.outputs`, exposed to prompts as `OUTPUT_FILES`.

<MultiOutputModesHero />

<p class="hero-caption">Two ways output filenames are determined: editing agents reuse the selected <code>INPUT_FILES</code>, while generator agents emit the fixed names declared in <code>task.outputs</code> (exposed as <code>OUTPUT_FILES</code>).</p>

### Declaring fixed outputs

```yaml
name: my_agent
task:
  rewrite: false
  outputs:
    - paper_section.tex
    - appendix.tex
  requests:
    - |
      [Request that emits one <document> per name in OUTPUT_FILES]
```

### Prompt template for multiple outputs

Iterate over `INPUT_FILES` (or `OUTPUT_FILES` when `task.outputs` is set) so the model emits one `<document name="...">` block per expected filename. Use `{{ INPUT_FILES | join(", ") }}` when the prompt needs a comma-separated list:

```
# Inside a task.requests entry:
Output one updated document for each input file, using the matching input
filename as the document name.

<documents>
{% for output in INPUT_FILES %}
<document name="{{ output }}">
% UPDATED_CONTENT_FOR_{{ output }}
</document>
{% endfor %}
</documents>
```

## Next steps

- [Custom agents](./custom-agents.md): design prompts for agents handling multiple outputs.
- [File management](./file-management.md): the file selection UI in detail.
- [Agent architecture](./agent-architecture.md): the overall agent execution flow.
