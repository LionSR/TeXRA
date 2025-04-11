# How TeXRA Agents Work: An Overview

At its core, a TeXRA agent is a recipe for instructing a Large Language Model (LLM) to perform a specific academic research task. This guide provides a high-level overview of how these agents are defined and how they execute your requests.

## Agent Definition: Settings & Prompts

Each agent's behavior is defined in a `.yaml` file (like `polish.yaml` for the built-in polish agent). These files have two main parts:

1.  **`settings`**: Define general operational parameters. For example:
    - `agentType`: Is it a complex `CoT` (Chain of Thought) agent that "thinks" step-by-step, or a simpler `direct` agent?
    - `prefills`: Text the agent should automatically start its response with (e.g., `<scratchpad>`).
    - _(Other settings control output format, inheritance, etc. See [Configuration](./configuration.md) and [Custom Agents](./custom-agents.md) for full details)._
2.  **`prompts`**: Contain text templates that TeXRA fills with your specific context (input files, instructions) to guide the LLM at different stages:
    - `systemPrompt`: Sets the overall role and high-level instructions for the LLM.
    - `userPrefix`: Provides the main context, including your input file(s) and the specific instruction you typed in the UI.
    - `userRequest`: Asks the LLM to perform the initial task (Round 0).
    - `userReflect`: Asks the LLM to review and improve its first response (Round 1, only used if "Reflect" is enabled).

_(For the exact structure and how to write these prompts for custom agents, see the [Custom Agents](./custom-agents.md) guide.)_

::: tip Transparency & Customization
The prompts described above (`systemPrompt`, `userPrefix`, etc.) represent TeXRA's structured approach to guiding the LLM. This structured, template-based system means the agent's behavior is transparent and highly customizable through the `.yaml` file, not a hidden black box.
:::

## Basic Execution Flow

When you click "Execute" in the TeXRA UI, TeXRA uses the selected agent's definition (`.yaml`) and your UI inputs to interact with the chosen LLM:

```mermaid
sequenceDiagram
    participant User
    participant TeXRA UI
    participant Agent Backend
    participant LLM API

    User->>TeXRA UI: Selects files, agent, instruction, model
    User->>TeXRA UI: Clicks Execute
    TeXRA UI->>Agent Backend: run(config)
    Agent Backend->>Agent Backend: Initialize (Load agent definition, read files)
    Note over Agent Backend: Constructs prompt from systemPrompt, userPrefix, userRequest templates + User Input
    Agent Backend->>LLM API: Create Response (Round 0 Prompt)
    Note over LLM API: Processes request based on prompts
    LLM API-->>Agent Backend: Response (Text + Usage + StopReason)
    Agent Backend->>Agent Backend: Process Response (Save *_r0_* output, check for continuation)
    Agent Backend-->>TeXRA UI: Update ProgressBoard / Signal Completion
```

**Key Stages:**

1.  **Initialization:** TeXRA loads the agent definition and reads the files you selected.
2.  **Prompt Construction:** It combines the agent's `systemPrompt`, `userPrefix` (filled with your files and instruction), and `userRequest` templates into a full prompt for the LLM.
3.  **LLM Interaction (Round 0):** TeXRA sends the prompt to the selected LLM API. The LLM generates a response.
4.  **Processing:** TeXRA receives the response, saves it to an output file (e.g., `filename_agent_r0_model.ext`), and checks if the LLM finished or needs to continue (if it hit token limits). You can monitor this in the [ProgressBoard](./progress-board.md). For LaTeX files, TeXRA can also automatically generate a `latexdiff` file comparing the output to the input, enhancing observability. See the [LaTeX Diff guide](./latex-diff.md) for details.

**Optional Reflection (Round 1):**

If you enable the "Reflect" option in the Tool Config section of the UI, TeXRA performs an additional step after Round 0 finishes successfully:

1.  **Reflection Prompt:** It uses the agent's `userReflect` prompt template to ask the LLM to critique and improve its own Round 0 output (which is included in the conversation history).
2.  **LLM Interaction (Round 1):** The LLM generates a revised response.
3.  **Processing:** TeXRA saves this refined output to a separate file (e.g., `filename_agent_r1_model.ext`).

This basic flow, potentially with the reflection step, allows TeXRA agents to perform targeted tasks based on their specific definitions and your instructions. For concrete examples of built-in agents, see the [Built-in Agent Reference](./built-in-agents.md).
