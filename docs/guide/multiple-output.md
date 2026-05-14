# Handling Multiple Files (Inputs & Outputs)

TeXRA excels at managing complex academic projects often split across multiple files, like a paper with several chapters or appendices. This guide explains how to work with multiple input files and how agents can generate multiple, distinct output files in a single run.

## Why Use Multiple Files?

Working with multiple files is often necessary when:

- Your source document is split (e.g., `chapter1.tex`, `chapter2.tex`, `appendixA.tex`).
- You need to apply consistent changes (like polishing or correcting) across related documents.
- You only want an agent to modify specific parts (e.g., only update `chapter2.tex` and `appendixA.tex` based on the full context).
- An agent needs to generate distinct outputs based on a single input (less common, but possible).

## UI for Multiple Files

The TeXRA UI provides dedicated sections for managing multiple files:

<!-- ![Multiple Files UI Placeholder](/images/multiple-files-ui.png) _(Placeholder: Screenshot highlighting Input Files & Multiple Outputs sections)_ -->

- **Input Files**: Use the "▼" toggle to add multiple source files. These are typically concatenated and provided as context to the selected agent.
  - **Multiple Outputs**:
    - Use the "▼" toggle to activate multiple output mode.
    - Use the "+" button (<wa-icon library="texra" name="add"></wa-icon>) to list the _exact filenames_ you expect the agent to generate. **Order matters** if the agent references them by position.
    - The list can be cleared (<wa-icon library="texra" name="trash"></wa-icon>).
    - If this section is _not_ toggled/activated, TeXRA expects the agent to produce only a single output file, named based on the primary input file.

_(See [File Management](./file-management.md) for general UI controls.)_

## How It Works: Agent Input

When you provide multiple input files, TeXRA typically combines their content (often wrapping each in `<document name=\"...\">` tags within a parent `<documents>` tag) and includes it in the prompt sent to the selected agent. The agent receives the combined context to inform its processing.

## How It Works: Agent Output & Extraction

This is the crucial part for generating multiple distinct files:

1. **User Specifies Outputs:** You list the desired output filenames in the "Multiple Outputs" UI section (e.g., `chapter2.tex`, `appendixA.tex`).
2. **Agent Generates Structured XML:** The selected agent must be designed (through its `prompts`) to produce a _single XML response_ containing separate blocks for each intended output file, using a structure like this:

   ```xml
   <latex_documents>  <!-- Or agent's specific documentTag -->
     <document name="chapter2.tex">
       % ... content for the first output file ...
     </document>
     <document name="appendixA.tex">
       % ... content for the second output file ...
     </document>
     ...
   </latex_documents>
   ```

3. **TeXRA Extracts:** The TeXRA backend (`OutputHandler.ts`) parses this XML response. It looks for `<document>` tags with a `name` attribute that **exactly matches** one of the filenames you listed in the UI.
4. **Files Saved:** For each matching tag found, TeXRA extracts the content within that tag and saves it to the corresponding filename. If the agent's response doesn't include a `<document>` tag with a name matching one you specified, that file will not be created or updated.

**Key Point:** The agent must be explicitly instructed via its prompts to
generate the `<document name=\"...\">` structure matching the output filenames
provided through `OUTPUT_FILES_ORDER`.

## Tracking Multi-Output Runs

TeXRA determines whether an agent advertises multiple-output support from its
`defaultOutputFiles` setting. During a run, the selected filenames are carried
as `outputFiles` and exposed to prompts through `OUTPUT_FILES_ORDER`. Stream
identifiers may still append `_multiple` for readability, but prompt rendering
and output extraction depend on the filename list, not on a separate YAML flag.

### Declaring multi-output agents in YAML

Custom workflow agents can advertise that they expect multiple outputs by
setting `settings.defaultOutputFiles` to the expected filenames. This enables
frontend affordances like the "∶∶" dropdown badge and gives prompts a default
`OUTPUT_FILES_ORDER` when the user has not supplied filenames.

```yaml
name: my_agent_multiple
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

Workflow prompts can branch on `OUTPUT_FILES_ORDER` to request and format
multiple outputs within the `<latex_documents>` tag. `OUTPUT_FILES_ORDER` is an
array of filenames, so templates can use `&#123;&#123; OUTPUT_FILES_ORDER[0] &#125;&#125;` for a
specific filename and `&#123;&#123; OUTPUT_FILES_ORDER | join(", ") &#125;&#125;` when the prompt
needs a readable list.

```yaml
# Inside a workflow agent's userRequest prompt:
# ... instructions ...
{% if OUTPUT_FILES_ORDER %}
The output files should be in this order: {{ OUTPUT_FILES_ORDER | join(", ") }}.
{% endif %}

# Use the following format:
<latex_documents>
<document name="{{ OUTPUT_FILES_ORDER[0] }}">
% 1ST_UPDATED_LATEX_DOCUMENT_1 HERE
</document>
<document name="{{ OUTPUT_FILES_ORDER[1] }}">
% 1ST_UPDATED_LATEX_DOCUMENT_2 HERE
</document>
... (repeat for all output files)
</latex_documents>
```

This instructs the LLM to generate the necessary XML structure that TeXRA's `OutputHandler` can parse.

## When to Use

- Applying consistent edits (e.g., `polish`, `correct`) across multiple related `.tex` files.
- Tasks where an agent naturally produces distinct outputs (though less common than editing existing files).
- Targeting agent modifications to specific files within a larger project.

## Next Steps

- [Custom Agents](./custom-agents.md): Learn how to design prompts for agents handling multiple outputs.
- [File Management](./file-management.md): Review the file selection UI in detail.
- [Agent Architecture](./agent-architecture.md): Understand the overall agent execution flow.

## Enabling Multiple Outputs

To enable multiple output files, simply click the toggle icon (▼) next to the "Multiple Outputs" label in the main TeXRA interface file selection area. This will expand the section, allowing you to manage the output file list.

## Managing Output Files

Once expanded, you can manage the output files:

1.  **Add Files**: Use the "Add" button (<wa-icon library="texra" name="add"></wa-icon>) to specify output filenames. You typically need one output file for each corresponding input file.
2.  **Remove Files**: Click the "-" button next to a file to remove it.
3.  **Reorder Files**: Drag and drop files to ensure the order matches the input file order.
4.  **Clear List**: Use the "Empty List" button (<wa-icon library="texra" name="trash"></wa-icon>) to remove all specified output files.

## Output Naming
