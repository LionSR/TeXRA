# Tool-Use Agents

Tool-use agents are interactive assistants that can take actions in your workspace. Unlike workflow agents that transform documents in one pass, tool-use agents have conversations with you and respond to follow-ups.

## Choosing an Agent

| If you want to... | Use |
|-------------------|-----|
| Edit files with feedback | `chat` |
| Explore without modifying | `ask` |
| Find papers and literature | `search` |
| Discuss research directions | `discuss` |
| Do symbolic math with Wolfram | `research` |
| Write Lean 4 proofs | `lean` |

## How It Works

1. You send a request
2. The agent reads files, searches, or takes actions as needed
3. The agent responds
4. You can send follow-ups to refine or continue

Sessions persist - you can close VS Code and continue later.

## Quick Comparison

| Agent | Can Edit Files | Literature Search | Special Features |
|-------|---------------|-------------------|------------------|
| `chat` | Yes | Yes | General purpose |
| `ask` | No | Yes | Safe exploration |
| `search` | No | Yes | Web + academic search |
| `discuss` | No | Yes | Research brainstorming |
| `research` | Yes | No | Wolfram Language |
| `lean` | Yes | No | Lean 4 integration |

## Creating Custom Agents

Create a YAML file with `agentType: toolUse`:

```yaml
name: my_agent
description: What it does

settings:
  agentType: toolUse
  tools:
    - read_file
    - write_file
    - edit_file
    # ... more as needed

prompts:
  systemPrompt: |
    Define the agent's role and guidelines here.
  userRequest: |
    {{ INSTRUCTION }}
```

See [Custom Agents](../guide/custom-agents) for the full list of available tools.
