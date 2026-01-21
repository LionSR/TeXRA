# Custom Agents

Create your own agents by writing YAML definition files. TeXRA supports two types:

- **Workflow agents** (`agentType: CoT` or `direct`) - Structured document processing
- **Tool-use agents** (`agentType: toolUse`) - Interactive sessions with tool access

## Getting Started

1. Open the **Agent Explorer** in the TeXRA sidebar
2. Find your "Custom Agents" folder
3. Create a new `.yaml` file
4. Define your agent using the schema below

Or use the **Create AI Agent** button to have Claude generate a starter template.

## Basic Structure

```yaml
name: my_agent
description: What this agent does

settings:
  agentType: CoT    # or 'direct' or 'toolUse'
  # ... type-specific settings

prompts:
  systemPrompt: |
    Define the AI's role here.
  userRequest: |
    {{ INSTRUCTION }}
```

## Inheriting from Built-in Agents

Extend an existing agent and override only what you need:

```yaml
name: formal_polish
inherits: polish
settings:
  temperature: 0.0
prompts:
  systemPrompt: |
    You are a formal academic editor...
```

**Available for inheritance:**
- Workflow: `polish`, `correct`, `merge`, `draw`, `ocr`, `transcribe_audio`
- Tool-use: `ask`, `chat`, `research`, `discuss`, `search`

## Workflow Agents

For document transformation with optional reflection rounds.

```yaml
settings:
  agentType: CoT          # or 'direct' for single-pass
  documentTag: latex_document
  outputExt: tex
  rounds: 2               # reflection rounds (CoT only)
```

Key prompts:
- `systemPrompt` - AI's role and constraints
- `userPrefix` - Document context with `{{ INPUT_CONTENT }}`
- `userRequest` - Task instructions (array for multi-round)

## Tool-Use Agents

For interactive sessions with file/web access.

```yaml
settings:
  agentType: toolUse
  tools:
    - read_file
    - write_file
    - edit_file
    - glob
    - grep
    - bash
```

Key prompts:
- `systemPrompt` - Role and tool usage guidelines
- `userRequest` - Usually just `{{ INSTRUCTION }}`

## Template Variables

Use `{{ variable }}` syntax in prompts:

| Variable | Description |
|----------|-------------|
| `{{ INSTRUCTION }}` | User's instruction text |
| `{{ INPUT_FILE }}` | Primary input file path |
| `{{ INPUT_CONTENT }}` | Primary input file content |
| `{{ ALL_INPUTS }}` | All input files as XML |
| `{{ ALL_REFERENCES }}` | All reference files as XML |

Jinja2 conditionals work too:

```yaml
{% if INSTRUCTION %}
Follow: {{ INSTRUCTION }}
{% endif %}
```

## Examples

The best way to learn is by reading the built-in agents:

- **Workflow agents**: `resources/agents/` in the TeXRA installation
- **Tool-use agents**: `resources/tool_use_agents/`

Use the Agent Explorer to browse and copy from these files.
