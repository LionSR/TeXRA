# Handling Multiple Files

TeXRA can process multiple input files and generate multiple output files in a single agent run.

## When to Use

- Source document split across files (chapters, appendices)
- Applying consistent changes across related documents
- Targeting modifications to specific files within a project

## UI Controls

**Input Files**: Use the toggle to add multiple source files. They are concatenated and provided as context.

**Multiple Outputs**:
1. Click toggle to activate
2. Use "+" to add exact output filenames (order matters)
3. If not activated, TeXRA produces a single output

See [File Management](./file-management.md) for general UI controls.

## How It Works

### Input

Multiple input files are wrapped in `<document name="...">` tags and combined in the prompt.

### Output

1. You specify output filenames in the UI
2. Agent generates XML with `<document name="filename">` blocks:

```xml
<latex_documents>
  <document name="chapter2_polish_r0_model.tex">
    % content for first file
  </document>
  <document name="appendixA_polish_r0_model.tex">
    % content for second file
  </document>
</latex_documents>
```

3. TeXRA extracts content from tags matching your specified filenames

The agent must be designed (via prompts) to generate this structure.

## Declaring Multi-Output Agents

Custom agents can declare multi-output support in YAML:

```yaml
name: my_agent_multiple
settings:
  isMultipleOutput: true
  defaultOutputFiles:
    - paper_section.tex
    - appendix.tex
```

This enables the UI badge even without a `_multiple.yaml` file.

## Example: `polish_multiple`

The `polish_multiple` agent prompts the model to use `{{ OUTPUT_FILES_ORDER }}`:

```yaml
<latex_documents>
<document name="{OUTPUT_FILES_ORDER[0]}">
% UPDATED CONTENT HERE
</document>
</latex_documents>
```

## Next Steps

- [Custom Agents](./custom-agents.md) - Design multi-output agent prompts
- [File Management](./file-management.md) - File selection UI details
