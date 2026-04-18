# AI Models

TeXRA supports models from multiple providers. Select models from the dropdown in the TeXRA UI. Hover over options to see context window and cost estimates.

**Model ID suffixes:**

- `T` = Thinking/reasoning mode enabled (shows chain-of-thought)
- `-` = Lighter/faster variant
- Numbers indicate version (e.g., `45` = 4.5, `25` = 2.5)

## Anthropic Models

| Model ID    | Use Case                              | Cost | Speed  |
| :---------- | :------------------------------------ | :--- | :----- |
| `opus47T`   | Top-tier reasoning, long-horizon work | $$$$ | Slow   |
| `opus47`    | Most capable for agentic coding       | $$$$ | Slow   |
| `opus46T`   | Complex tasks with reasoning          | $$$$ | Slow   |
| `opus46`    | High quality, complex tasks           | $$$$ | Slow   |
| `sonnet46T` | All-rounder with reasoning            | $$$  | Medium |
| `sonnet46`  | Strong all-rounder                    | $$$  | Medium |
| `haiku45T`  | Fast with reasoning                   | $$   | Fast   |
| `haiku45`   | Fast responses                        | $$   | Fast   |

Opus 4.7, Opus 4.6, and Sonnet 4.6 include the full 1M context window at standard pricing — no opt-in or beta header required. Other Claude models use a 200K context window.

Claude Opus 4.7 uses adaptive thinking only (extended thinking with a manual `budget_tokens` is no longer accepted). TeXRA's reasoning-effort selector maps to Anthropic's effort levels automatically — pick `opus47T` with Extra High effort for the strongest agentic coding and long-horizon tasks. Opus 4.7 also supports high-resolution images (up to 2576px / 3.75MP) for better figure, chart, and screenshot understanding.

## OpenAI Models

| Model ID     | Use Case                  | Cost | Speed  |
| :----------- | :------------------------ | :--- | :----- |
| `gpt54pro`   | Premium reasoning         | $$$$ | Slow   |
| `gpt54`      | Flagship reasoning        | $$$  | Medium |
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

## MiniMax Models

| Model ID     | Use Case                           | Cost | Speed  |
| :----------- | :--------------------------------- | :--- | :----- |
| `minimaxM27` | Flagship with interleaved thinking | $$   | Medium |
| `minimaxM25` | Strong all-rounder                 | $$   | Medium |

MiniMax uses interleaved thinking (chain-of-thought woven into responses). API keys are region-specific — international keys (api.minimax.io) and China keys (api.minimaxi.com) are not interchangeable. Toggle the region in the Models tab.

- **International**: Get your API key at [platform.minimax.io](https://platform.minimax.io/)
- **China**: Get your API key at [platform.minimaxi.com](https://platform.minimaxi.com/)
- **Coding Plan**: MiniMax offers monthly subscription plans ($10/$20/$50/mo) as an alternative to pay-as-you-go. Coding Plan keys are **not interchangeable** with standard API keys — enter your Coding Plan key via "Set API Key" as usual. [Subscribe here](https://platform.minimax.io/subscribe/coding-plan).

## GLM (Zhipu AI / Z.AI) Models

| Model ID    | Use Case                             | Cost | Speed  |
| :---------- | :----------------------------------- | :--- | :----- |
| `glm5`      | Flagship open-source model           | $$$  | Medium |
| `glm5turbo` | Fast inference, agent-optimized      | $$$  | Medium |
| `glm47`     | Programming and multi-step reasoning | $$   | Medium |
| `glm46v`    | Multimodal vision model              | $$   | Medium |
| `glm45`     | Hybrid reasoning (MoE)               | $$   | Medium |

GLM models support thinking mode (reasoning is shown inline). The API uses a non-standard base path (`/api/paas/v4`), which TeXRA handles automatically.

- **International (Z.AI)**: Get your API key at [z.ai](https://z.ai/) — endpoint: api.z.ai
- **China (BigModel)**: Get your API key at [open.bigmodel.cn](https://open.bigmodel.cn/) — endpoint: open.bigmodel.cn (default)
- **Coding Plan**: GLM offers monthly subscription plans as an alternative to pay-as-you-go, with access to all GLM models. Coding Plan uses a separate endpoint (`/api/coding/paas/v4`). Enable the "Coding Plan" toggle in the Models tab. [Subscribe here](https://z.ai/subscribe).

## Grok / xAI Models

| Model ID | Use Case                        | Cost | Speed  |
| :------- | :------------------------------ | :--- | :----- |
| `grok4`  | Large context (256k), reasoning | $$$  | Medium |
| `grok3`  | Large context (131k)            | $$$  | Medium |
| `grok2v` | Vision-enabled                  | $$   | Medium |

## Choosing a Model

- **Simple tasks**: Fast, cheap models (`gemini3f`, `gpt5-`, `haiku45`)
- **Complex tasks**: Powerful models (`opus47`, `opus46`, `gpt54pro`)
- **Code-heavy / LaTeX editing**: Coding models (`gpt53codex`, `opus47T`)
- **Reasoning-heavy**: Thinking models (`opus47T`, `sonnet46T`, `opus46T`, `deepseekT`)
- **Large documents**: High-context models (`gemini*`, `gpt41`)

## Configuration

Customize available models in VS Code Settings under `texra.models`:

```json
"texra.models": [
  "gemini31p",
  "sonnet46T",
  "opus47T",
  "gpt54",
  "deepseekT"
]
```

## Using OpenRouter

To access additional models or alternative pricing:

1. Get an [OpenRouter](https://openrouter.ai/) API key
2. Add via `TeXRA: Set API Key` command
3. In the Dashboard → Models tab → API Configuration, expand the OpenRouter row and enable **"Use OpenRouter for All Models"**

## Streaming

Enable streaming for long responses in settings:

```json
"texra.model.useStreaming": true
```

## Next Steps

- [Built-in Agents](./built-in-agents.md): See which agents work with different models
- [Configuration](./configuration.md): Model-related settings
