# Agent Architecture

TeXRA agents are recipes for instructing large language models to perform academic research tasks. Each agent is defined in a YAML file that specifies its behavior, prompts, and settings.

## Agent Categories

| Category | Agent Types | Best For |
|----------|-------------|----------|
| **Workflow** | `CoT`, `direct` | Structured document transformations with predictable outputs |
| **ToolUse** | `toolUse` | Interactive research tasks requiring external tools |

### Workflow Agents

Run for a predetermined number of rounds and produce structured output files.

- **CoT (Chain-of-Thought)**: Multi-round agents that reason step-by-step using `<scratchpad>`, then refine output through reflection. Default: 2+ rounds.
- **Direct**: Single-pass agents for quick transformations. Default: 1 round.

### Tool-Use Agents

Run interactive sessions where the model calls external tools (file operations, web search, code execution) and waits for follow-up messages. Sessions persist and can be resumed.

## Agent Definition Files

Each agent's behavior is defined in a YAML file with two main parts:

**Settings** define operational parameters:
- `agentType`: `CoT`, `direct`, or `toolUse`
- `prefills`: Text the agent starts its response with (workflow only)
- `tools`: Array of tool definitions (tool-use only)

**Prompts** contain templates filled with your context:
- `systemPrompt`: Role and high-level instructions
- `userPrefix`: Main context including input files (`{{ INPUT_CONTENT }}`) and your instruction (`{{ INSTRUCTION }}`)
- `userRequest`: The task request. For workflow agents, multiple entries enable reflection rounds.

See [Custom Agents](./custom-agents.md) for full details on creating agent definitions.

## How Execution Works

### Workflow Agents

```mermaid
sequenceDiagram
    participant User
    participant TeXRA
    participant LLM

    User->>TeXRA: Select files, agent, instruction
    User->>TeXRA: Click Execute
    TeXRA->>TeXRA: Load agent, construct prompt
    TeXRA->>LLM: Send prompt (Round 0)
    LLM-->>TeXRA: Response with reasoning + output
    TeXRA->>TeXRA: Save output file (*_r0_*)
    opt Reflection rounds
        TeXRA->>LLM: Send reflection prompt (Round 1+)
        LLM-->>TeXRA: Refined output
        TeXRA->>TeXRA: Save refined file (*_r1_*)
    end
    TeXRA-->>User: Complete
```

If output gets cut off by token limits, TeXRA automatically sends a continuation prompt.

### Reflection

After generating an initial output (Round 0), TeXRA agents that define reflection prompts evaluate and refine their work (Round 1):

<div class="reflection-pdf-viewer">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Original vs. Round 0</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Original vs. Round 1</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Round 0 vs. Round 1</button>
  </div>
  <iframe src="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf" id="pdf-frame" class="reflection-pdf-frame"></iframe>
  <a href="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf" target="_blank" id="pdf-link" class="reflection-pdf-link">View full example</a>
</div>

<div class="reflection-legend">
  <div class="legend-item"><span class="del">Red strikethrough</span>: Round 0 content revised in Round 1</div>
  <div class="legend-item"><span class="add">Blue underlined</span>: New/improved content added in Round 1</div>
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

### Tool-Use Agents

```mermaid
sequenceDiagram
    participant User
    participant TeXRA
    participant LLM
    participant Tools

    User->>TeXRA: Provide instruction
    TeXRA->>LLM: Send with tool definitions
    loop Until task complete
        LLM-->>TeXRA: Response (text or tool calls)
        alt Tool calls
            TeXRA->>Tools: Execute tools
            Tools-->>TeXRA: Results
            TeXRA->>LLM: Continue with results
        else No tool calls
            TeXRA-->>User: Wait for follow-up
            User->>TeXRA: Follow-up message
            TeXRA->>LLM: Continue conversation
        end
    end
```

Sessions persist and can be resumed after VS Code restarts.

## Summary

| Aspect | Workflow Agents | Tool-Use Agents |
|--------|-----------------|-----------------|
| **Rounds** | Fixed (1 for Direct, 2+ for CoT) | Dynamic |
| **Output** | Structured files (`_r0_`, `_r1_`) | Conversational |
| **Session** | Single execution | Persistent, resumable |
| **Use Case** | Document transformation | Interactive research |

See [Built-in Agents](./built-in-agents.md) for examples.
