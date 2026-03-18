# AI Models

TeXRA supports models from multiple providers. Select models from the dropdown in the TeXRA UI. Hover over options to see context window and cost estimates.

**Model ID suffixes:**

- `T` = Thinking/reasoning mode enabled (shows chain-of-thought)
- `-` = Lighter/faster variant
- Numbers indicate version (e.g., `45` = 4.5, `25` = 2.5)

## Anthropic Models

| Model ID    | Use Case                     | Cost | Speed  |
| :---------- | :--------------------------- | :--- | :----- |
| `opus46T`   | Complex tasks with reasoning | $$$$ | Slow   |
| `opus46`    | High quality, complex tasks  | $$$$ | Slow   |
| `sonnet46T` | All-rounder with reasoning   | $$$  | Medium |
| `sonnet46`  | Strong all-rounder           | $$$  | Medium |
| `haiku45T`  | Fast with reasoning          | $$   | Fast   |
| `haiku45`   | Fast responses               | $$   | Fast   |

Opus 4.6 and Sonnet 4.6 include the full 1M context window at standard pricing — no opt-in or beta header required. Other Claude models use a 200K context window.

## OpenAI Models

| Model ID     | Use Case                  | Cost | Speed  |
| :----------- | :------------------------ | :--- | :----- |
| `gpt54pro`   | Premium reasoning         | $$$$ | Slow   |
| `gpt54`      | Flagship reasoning        | $$$  | Medium |
| `gpt54-`     | Fast flagship (400K)      | $$   | Fast   |
| `gpt54--`    | Budget flagship (400K)    | $    | Fast   |
| `gpt53codex` | Coding specialist         | $$$  | Medium |
| `gpt41`      | Long context (1M), vision | $$$  | Medium |
| `gpt5-`      | Fast flagship             | $$   | Fast   |

GPT-5 reasoning summaries require account verification. Enable with `texra.model.gpt5ReasoningSummary`.

## Google Models

| Model ID     | Use Case                             | Cost | Speed  |
| :----------- | :----------------------------------- | :--- | :----- |
| `gemini31p`  | Pro with reasoning, 1M context       | $$$  | Medium |
| `gemini3f`   | Flash with reasoning, 1M context     | $$   | Fast   |
| `gemini25p`  | Strong reasoning, vision, 1M context | $$$  | Medium |
| `gemini25f`  | Fast reasoning, 1M context           | $$   | Fast   |
| `gemini25f-` | Budget flash, 64k context            | $    | Fast   |

## DeepSeek Models

| Model ID    | Use Case            | Cost | Speed  |
| :---------- | :------------------ | :--- | :----- |
| `deepseek`  | V3.2 chat mode      | $    | Fast   |
| `deepseekT` | V3.2 with reasoning | $    | Medium |
| `dsr1`      | Advanced reasoning  | $$   | Medium |

## Moonshot Kimi Models

| Model ID  | Use Case                | Cost | Speed  |
| :-------- | :---------------------- | :--- | :----- |
| `kimi25T` | K2.5 with thinking mode | $$$  | Medium |
| `kimi25`  | K2.5, agent tasks       | $$$  | Medium |

## DashScope Qwen Models

| Model ID    | Use Case                      | Cost | Speed  |
| :---------- | :---------------------------- | :--- | :----- |
| `qwen3max`  | Flagship coding, 262k context | $$$  | Medium |
| `qwenplus`  | Hybrid thinking, 1M context   | $$   | Medium |
| `qwenturbo` | Fast with optional thinking   | $    | Fast   |

## Grok / xAI Models

| Model ID | Use Case                        | Cost | Speed  |
| :------- | :------------------------------ | :--- | :----- |
| `grok4`  | Large context (256k), reasoning | $$$  | Medium |
| `grok3`  | Large context (131k)            | $$$  | Medium |
| `grok2v` | Vision-enabled                  | $$   | Medium |

## Choosing a Model

- **Simple tasks**: Fast, cheap models (`gemini3f`, `gpt5-`, `haiku45`)
- **Complex tasks**: Powerful models (`opus46`, `gpt54pro`)
- **Code-heavy / LaTeX editing**: Coding models (`gpt53codex`)
- **Reasoning-heavy**: Thinking models (`sonnet46T`, `opus46T`, `deepseekT`)
- **Large documents**: High-context models (`gemini*`, `gpt41`)

## Configuration

Customize available models in VS Code Settings under `texra.models`:

```json
"texra.models": [
  "gemini31p",
  "sonnet46T",
  "opus46T",
  "gpt54",
  "deepseekT"
]
```

## Using OpenRouter

To access additional models or alternative pricing:

1. Get an [OpenRouter](https://openrouter.ai/) API key
2. Add via `TeXRA: Set API Key` command
3. Enable `texra.model.useOpenRouter` in settings

## Streaming

Enable streaming for long responses in settings:

```json
"texra.model.useStreaming": true
```

## Next Steps

- [Built-in Agents](./built-in-agents.md): See which agents work with different models
- [Configuration](./configuration.md): Model-related settings
