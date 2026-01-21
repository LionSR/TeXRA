# AI Models

TeXRA supports models from multiple providers. Select models from the dropdown in the TeXRA UI. Hover over options to see context window and cost estimates.

**Model ID suffixes:**
- `T` = Thinking/reasoning mode enabled (shows chain-of-thought)
- `-` = Lighter/faster variant
- Numbers indicate version (e.g., `45` = 4.5, `25` = 2.5)

## Anthropic Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `opus45T` | Complex tasks with reasoning | $$$$ | Slow |
| `opus45` | High quality, complex tasks | $$$$ | Slow |
| `sonnet45T` | All-rounder with reasoning | $$$ | Medium |
| `sonnet45` | Strong all-rounder | $$$ | Medium |
| `haiku45T` | Fast with reasoning | $$ | Fast |
| `haiku45` | Fast responses | $$ | Fast |
| `haiku35` | Budget option | $ | Fast |

For 1M-token context on Sonnet 4/4.5, enable `texra.model.useAnthropic1MBeta` in settings.

## OpenAI Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `gpt52pro` | Premium reasoning | $$$$ | Slow |
| `gpt52` | Flagship reasoning | $$$ | Medium |
| `gpt51` | Flagship, 400k context | $$$ | Medium |
| `gpt5` | Flagship reasoning | $$$ | Medium |
| `gpt5-` | Fast flagship | $$ | Fast |
| `gpt41` | Long context (1M), vision | $$$ | Medium |
| `gpt4o` | Strong all-rounder, vision | $$$ | Medium |
| `o3pro` | Heavy compute reasoning | $$$$ | Slow |
| `o3` | Coding, tool calling | $$$ | Medium |
| `o1` | Advanced reasoning | $$$$ | Slow |

GPT-5 reasoning summaries require account verification. Enable with `texra.model.gpt5ReasoningSummary`.

## Google Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `gemini3p` | Pro with reasoning, 1M context | $$$ | Medium |
| `gemini3f` | Flash with reasoning, 1M context | $$ | Fast |
| `gemini25p` | Strong reasoning, vision, 1M context | $$$ | Medium |
| `gemini25f` | Fast reasoning, 1M context | $$ | Fast |
| `gemini25f-` | Budget flash, 64k context | $ | Fast |

## DeepSeek Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `deepseek` | V3.2 chat mode | $ | Fast |
| `deepseekT` | V3.2 with reasoning | $ | Medium |
| `dsr1` | Advanced reasoning | $$ | Medium |

## Moonshot Kimi Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `kimi2` | Agent tasks, 256k context | $$$ | Medium |
| `kimi2T` | K2 with thinking mode | $$ | Medium |
| `kimit` | Detailed reasoning with vision | $$$ | Medium |

## DashScope Qwen Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `qwen3max` | Flagship coding, 262k context | $$$ | Medium |
| `qwenplus` | Hybrid thinking, 1M context | $$ | Medium |
| `qwenturbo` | Fast with optional thinking | $ | Fast |

## Grok / xAI Models

| Model ID | Use Case | Cost | Speed |
|:---------|:---------|:-----|:------|
| `grok4` | Large context (256k), reasoning | $$$ | Medium |
| `grok3` | Large context (131k) | $$$ | Medium |
| `grok2v` | Vision-enabled | $$ | Medium |

## Choosing a Model

- **Simple tasks**: Fast, cheap models (`gemini25f-`, `gpt5--`, `haiku35`)
- **Complex tasks**: Powerful models (`opus45`, `gpt52pro`, `o1`)
- **Reasoning-heavy**: Thinking models (`sonnet45T`, `deepseekT`, `o3`)
- **Large documents**: High-context models (`gemini*`, `gpt41`, `gpt5`)

## Configuration

Customize available models in VS Code Settings under `texra.models`:

```json
"texra.models": [
  "gemini3p",
  "sonnet45T",
  "opus45T",
  "gpt52",
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
