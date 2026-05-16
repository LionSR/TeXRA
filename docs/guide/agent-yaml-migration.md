# Agent YAML Migration Guide

This guide is for users with **custom agent YAMLs** (in their custom-agents directory). TeXRA's built-in and remote reference agents are migrated automatically, but custom YAMLs are user-owned and must be edited by hand.

If you've never written a custom agent, skip this guide.

## What changed and why

Three rounds of cleanup landed across recent releases:

| Round                       | What                                                                                                                                                                                         | Why                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W2** (PR #4035, May 2026) | Merge `Reference` + `Auxiliary` file pickers into one **Context** picker                                                                                                                     | The two pickers had overlapping extensions (`.tex`, `.md`) and an invisible conceptual split that scared new users                                                            |
| **W3** (PR #4035, May 2026) | Retire the `_multiple` agent YAML variants                                                                                                                                                   | Keeping `foo.yaml` and `foo_multiple.yaml` in sync by hand was a maintenance tax. One unified YAML now handles single- and multi-document output via `documentTag: documents` |
| **W4** (this PR)            | Drop the **single-file slot** for input/context/media; retire `ADDITIONAL_INPUTS`; retire the separate output-order prompt variable; rewrite the prompt protocol as "one document per input" | The single-vs-multi distinction in the UI was extra cognitive load that newer models don't need                                                                               |

## Quick reference: old → new

| You had                                                                        | Replace with                                                            | Notes                                                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `referenceFile`, `referenceFiles` (settings, persisted state)                  | `contextFile`, `contextFiles` → just **`contextFiles`**                 | Auto-migrated at runtime                                                                                                          |
| `auxiliaryFile`, `auxiliaryFiles`                                              | folded into `contextFiles`                                              | Auto-migrated at runtime                                                                                                          |
| `inputFile`, `mediaFile`, `contextFile` (the _single_ slots in agent UI state) | `inputFiles[0]`, `mediaFiles[0]`, `contextFiles[0]`                     | Auto-migrated at runtime                                                                                                          |
| `{{ ALL_REFERENCES }}`, `{{ ALL_AUXILIARYS }}`                                 | **`{{ ALL_CONTEXTS }}`**                                                | Old aliases still resolve at runtime, but new YAMLs should use the canonical name                                                 |
| `{{ REFERENCE_CONTENT }}`, `{{ AUXILIARY_CONTENT }}`                           | dropped                                                                 | No replacement — these were content of the _single_ reference/auxiliary file. Use `{{ ALL_CONTEXTS }}` (XML of all context files) |
| `{{ ADDITIONAL_INPUTS }}`                                                      | **drop the line**                                                       | The "additional" concept disappears with the single-slot collapse. `{{ ALL_INPUTS }}` already includes everything                 |
| `{{ INPUT_FILE }}`, `{{ INPUT_CONTENT }}`                                      | still resolve at runtime as aliases for `inputFiles[0]` and its content | Custom YAMLs that reference these keep working. New YAMLs should prefer `{{ ALL_INPUTS }}` for the document body                  |
| Output-order variables and `{% if ... %}` single-vs-multiple branches          | iterate over `{{ INPUT_FILES }}` for edit outputs                       | Agents that write fresh filenames use `{{ OUTPUT_FILES }}` from `settings.defaultOutputFiles`                                     |
| `foo_multiple.yaml` siblings                                                   | merged into the base `foo.yaml`                                         | If you cloned a `_multiple` variant, copy your customizations onto the base                                                       |
| `latex_documents` / `latex_document` document tag                              | `documents` (use `documentTag: documents` in settings)                  | The unified protocol uses `<documents><document name="...">...</document></documents>`                                            |

## What TeXRA migrates for you (auto)

These are handled by Zod `.preprocess` shims at the persistence boundaries — you don't have to touch your saved state or your VS Code settings:

- **Persisted webview state**: legacy `referenceFile`/`referenceFiles`/`auxiliaryFile`/`auxiliaryFiles`/`inputFile`/`contextFile`/`mediaFile` keys in your VS Code Memento are folded into the new `*Files` shape on the next webview load.
- **Execution history**: rows in the executions store written by older versions parse correctly via the same migration shim. History tab, Restore, and Rerun keep working.
- **VS Code settings**: if you customized `texra.files.included.referenceExtensions` or `texra.files.included.auxiliaryExtensions`, the new `texra.files.included.contextExtensions` reads them as fallbacks. The removed `texra.files.ignored.auxiliaryKeywords` is preserved as a fallback that folds into the context category's keyword filter.
- **Template variable aliases**: `{{ ALL_REFERENCES }}`, `{{ ALL_AUXILIARYS }}`, `{{ INPUT_FILE }}`, `{{ INPUT_CONTENT }}`, `{{ CONTEXT_FILE }}`, `{{ CONTEXT_CONTENT }}`, `{{ MEDIA_FILE }}` keep resolving at runtime so older custom YAMLs don't break. They are derived from the new multi-list shape (e.g., `{{ INPUT_FILE }}` = `inputFiles[0]`).

## What you must migrate by hand

If you have a **custom agent YAML** in your custom-agents directory, walk through the steps below.

### Step 1 — Set `documentTag: documents`

```yaml
settings:
  agentCategory: workflow
  documentTag: documents # was: latex_document or latex_documents
  endTag: </documents> # auto-derived from documentTag; safe to drop
```

### Step 2 — Replace `{{ ALL_AUXILIARYS }}` and `{{ ALL_REFERENCES }}` with `{{ ALL_CONTEXTS }}`

Old:

```yaml
prompts:
  userPrefix: |
    Project context:
    <documents>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>
```

New:

```yaml
prompts:
  userPrefix: |
    Project context:
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>
```

Why this works:

- `{{ ALL_CONTEXTS }}` already wraps every context file in `<document name="...">...</document>`.
- `{{ ALL_INPUTS }}` already wraps every input file the same way — including what used to be the "primary" input. There is no separate primary.

### Step 3 — Use input filenames for edit outputs

If your agent rewrites each input as one output (the common case — `correct`, `polish`, `enhance` style), the conditional is unnecessary now:

Old:

```yaml
userRequest:
  - |
    {% if INPUT_FILES %}
    Output the revised files as multiple documents in the order:
    {{ INPUT_FILES | join(', ') }}.
    <documents>
    <document name="{{ INPUT_FILES[0] }}">...</document>
    <document name="{{ INPUT_FILES[1] }}">...</document>
    </documents>
    {% else %}
    Output the revised file as <documents><document name="{{ INPUT_FILE }}">...</document></documents>.
    {% endif %}
```

New:

```yaml
userRequest:
  - |
    Output one revised <document name="..."> per input. Wrap them all in
    <documents>...</documents>.
```

If your agent writes to a _different_ filename than its inputs, declare
`settings.defaultOutputFiles` and iterate over `OUTPUT_FILES`:

```yaml
userRequest:
  - |
    Merge the original/edited pairs and emit:
    <documents>
    {% for name in OUTPUT_FILES %}
    <document name="{{ name }}">...</document>
    {% endfor %}
    </documents>
```

### Step 4 — Drop `_multiple` siblings

If you cloned `foo_multiple.yaml` from an older release and customized it:

1. Open your `foo.yaml` (the base).
2. Apply the same customizations.
3. Make sure `documentTag: documents` is set.
4. Delete `foo_multiple.yaml` from your custom-agents directory.

### Step 5 — Update `requiredFiles` / `filePatternsContain` categories

If your YAML uses `filePatternsContain.categories`, replace `'auxiliaryFile'` / `'auxiliaryFiles'` / `'referenceFile'` / `'referenceFiles'` with `'contextFile'` / `'contextFiles'`:

```yaml
filePatternsContain:
  - pattern: 'bibliography'
    varName: BIBLIOGRAPHY
    categories: ['contextFile', 'contextFiles'] # was: ['auxiliaryFile', 'auxiliaryFiles']
```

## Full before/after example

**Before** (typical pre-W4 custom agent):

```yaml
name: my_polish
description: Polish writing while preserving meaning.

settings:
  agentCategory: workflow
  documentTag: latex_document
  endTag: </latex_document>
  isMultipleOutput: false # also: my_polish_multiple.yaml exists with isMultipleOutput: true
  temperature: 0.3

prompts:
  systemPrompt: |
    You polish academic writing.
  userPrefix: |
    <latex_document>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </latex_document>

  userRequest:
    - |
      Polish the document. Output as
      <latex_document><document name="{{ INPUT_FILE }}">...</document></latex_document>.
```

**After** (W4 canonical shape, single YAML handles 1 or N inputs):

```yaml
name: my_polish
description: Polish writing while preserving meaning.

settings:
  agentCategory: workflow
  documentTag: documents
  temperature: 0.3

prompts:
  systemPrompt: |
    You polish academic writing.
  userPrefix: |
    <documents>
    {{ ALL_CONTEXTS }}
    {{ ALL_INPUTS }}
    </documents>

  userRequest:
    - |
      Polish each document. Output one revised <document name="..."> per input,
      wrapped in <documents>...</documents>.
```

The `_multiple` sibling is gone; this YAML works for one input or several.

## When something looks wrong

- **Empty context section in prompt** — your YAML uses an old alias like `{{ ALL_AUXILIARYS }}` that returns content but no UI exposes the "auxiliary" picker any more, so users have nothing to attach. Switch to `{{ ALL_CONTEXTS }}` and your users see the unified Context picker.
- **Output file ends up named `output.tex` instead of the input filename** — your YAML has `<document name="output.tex">` hard-coded. Use `<document name="{{ INPUT_FILE }}">` (resolves to `inputFiles[0]`) or omit the inner `<document>` template and let the agent name files based on `{{ ALL_INPUTS }}` content.
- **Two single agents both write the same file** — pre-W4 you may have had distinct `inputFile` and `inputFiles[0]` semantics; now they're the same slot. Adjust your prompt to handle a single list.
- **Custom keyword filter no longer matches** — if you customized `texra.files.ignored.auxiliaryKeywords` and the model-name filter is still active but applied somewhere unexpected, note that the legacy setting is now folded into the `Context` category's `ignoredKeywords` (back-compat shim). Consider migrating to `texra.files.ignored.keywords` if you want the filter to apply across all categories.

## Reference: full template variable list (post-W4)

Workflow agents receive these template variables at runtime:

| Variable                     | Resolves to                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `{{ INPUT_FILE }}`           | `inputFiles[0]` (alias)                                                               |
| `{{ INPUT_CONTENT }}`        | content of `inputFiles[0]` (alias)                                                    |
| `{{ ALL_INPUTS }}`           | XML of all input files: `<document name="...">...</document>` per file                |
| `{{ LIST_OF_ALL_INPUTS }}`   | comma-separated list of input file paths                                              |
| `{{ ALL_CONTEXTS }}`         | XML of all context files (`.bib`/`.bbl`, reference papers, `.sty`/`.cls`)             |
| `{{ LIST_OF_ALL_CONTEXTS }}` | comma-separated list of context file paths                                            |
| `{{ INSTRUCTION }}`          | the user's free-text instruction for this run                                         |
| `{{ INPUT_FILES }}`          | array of selected input filenames; edit agents should output one document per entry   |
| `{{ OUTPUT_FILES }}`         | array of declared generated output filenames; only set for explicit/generated outputs |
| `{{ EDITED_FILE }}`          | path of the edited file (used in `merge`)                                             |
| `{{ EDITED_CONTENT }}`       | content of the edited file                                                            |
| `{{ MEDIA_FILE }}`           | `mediaFiles[0]` (alias). Media content is handled separately for multimodal models    |

Tool-use agents receive only `{{ INSTRUCTION }}` — files are accessed via tool calls.
