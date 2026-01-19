# Reference Agents

This folder contains example agent definitions for understanding the TeXRA agent system. These agents are **not bundled** with the VS Code extension but serve as documentation and templates for creating new agents.

## Agent Categories

### Workflow Agents (`workflow/`)

Workflow agents process documents through a structured pipeline:
- **Input**: LaTeX files to transform
- **Output**: Modified LaTeX files (same structure as input)
- **Use cases**: Grammar correction, style polishing, critique/review, figure generation

Key settings:
- `agentType`: `direct`, `cot` (chain-of-thought), `merge`, or `workflow`
- `documentTag`: XML tag wrapping the output (e.g., `latex_document`)
- `outputExt`: Output file extension (usually `tex`)
- `prefills`: Model response prefill for better formatting

### Tool-Use Agents (`tool-use/`)

Tool-use agents interact dynamically using available tools:
- **Input**: Natural language instruction with file paths
- **Output**: Conversational response (may include file operations)
- **Use cases**: Research, search, Q&A, code analysis

Key settings:
- `agentType`: `toolUse`
- `tools`: List of available tools

## Agent YAML Schema

```yaml
name: agent-name           # Unique identifier (no spaces)
description: Short description shown in UI dropdowns.

settings:
  agentType: direct        # Agent implementation type
  documentTag: latex_document
  endTag: </latex_document>
  outputExt: tex
  prefills:
    - "Here is the revised document. <latex_document>"

prompts:
  systemPrompt: |
    System prompt defining the agent's role and constraints.

  userPrefix: |
    Context provided before the document content.
    Available variables:
    - {{ INPUT_CONTENT }}: Primary input file content
    - {{ INPUT_FILE }}: Primary input filename
    - {{ ALL_AUXILIARYS }}: Auxiliary files (like .bib)
    - {{ ALL_REFERENCES }}: Reference files
    - {{ ADDITIONAL_INPUTS }}: Additional input files
    - {{ INSTRUCTION }}: User's specific instruction

  userRequest: |
    The actual task request sent to the model.
```

## Template Variables

Workflow agents have access to these Jinja2 variables:

| Variable | Description |
|----------|-------------|
| `{{ INPUT_CONTENT }}` | Content of the primary input file |
| `{{ INPUT_FILE }}` | Filename of primary input |
| `{{ ALL_AUXILIARYS }}` | All auxiliary files (bib, commands) |
| `{{ ALL_REFERENCES }}` | All reference files |
| `{{ ADDITIONAL_INPUTS }}` | Additional input files beyond primary |
| `{{ INSTRUCTION }}` | User-provided instruction |
| `{{ MEDIA_CONTENT }}` | Media files (images) |

Tool-use agents have:

| Variable | Description |
|----------|-------------|
| `{{ INSTRUCTION }}` | User's instruction |
| `{{ WORKFLOW_AGENTS }}` | List of available workflow agents |
| `{{ TOOL_USE_AGENTS }}` | List of available tool-use agents |
| `{{ IS_ANTHROPIC_MODEL }}` | Boolean for model-specific prompts |

## Adding an Agent to Production

1. Copy the YAML file to the appropriate folder:
   - Workflow: `resources/agents/`
   - Tool-use: `resources/tool_use_agents/`

2. Add to `package.json` configuration:
   - Workflow agents: `texra.agents` array
   - Tool-use agents: `texra.toolUseAgents` array

3. Rebuild the extension

## File Organization

```
docs/reference-agents/
├── README.md           # This file
├── workflow/
│   ├── critique.yaml   # Paper review/critique
│   ├── expand.yaml     # Section expansion
│   └── summarize.yaml  # Document summarization
└── tool-use/
    ├── cite.yaml       # Citation finder
    └── outline.yaml    # Document outliner
```
