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

Claude Opus 4.7 uses adaptive thinking only (extended thinking with a manual `budget_tokens` is no longer accepted). TeXRA's reasoning-effort selector maps to Anthropic's effort levels automatically — pick `opus47T` with Extra High effort for the strongest agentic coding and long-horizon tasks. Opus 4.7 also supports high-resolution images (up to 2576px / 3.75MP) for better figure, chart, and screenshot understanding; note that TeXRA downscales images above `texra.maxImageDimension` (default 2000px) before sending, so raise that setting if you want to take full advantage of Opus 4.7's higher limit.

## OpenAI Models

| Model ID   | Use Case                       | Cost  | Speed  |
| :--------- | :----------------------------- | :---- | :----- |
| `gpt55pro` | Top-tier reasoning, 1M context | $$$$$ | Slow   |
| `gpt55`    | Flagship reasoning             | $$$$  | Medium |
| `gpt54`    | Mid-tier reasoning             | $$$   | Medium |
| `gpt54-`   | Lower-cost reasoning           | $$    | Fast   |
| `gpt54--`  | Budget reasoning               | $     | Fast   |

GPT-5.5 is OpenAI's latest flagship and the model TeXRA pins the [Codex CLI](./codex-cli.md) to. GPT-5.5 Pro (`gpt55pro`) extends GPT-5.5 with a 1.05M context window and `xhigh` default reasoning for the hardest planning and long-horizon tasks, at premium pricing — it is hidden by default; enable it from Settings → Models when you need it. The GPT Pro variants (`gpt5pro`, `gpt52pro`, `gpt55pro`) charge $15-$30 per 1M input and $120-$180 per 1M output, so for one-off hard questions consider enabling the `inquiry` tool and pasting the answer from your own ChatGPT subscription instead of running a full agent turn against the API. `gpt54` and its mini/nano variants remain the lower-cost option for most workloads. See the [API reference](https://developers.openai.com/api/docs) for full capabilities.

GPT-5 reasoning summaries require account verification. Enable with `texra.model.gpt5ReasoningSummary`.

## Google Models

| Model ID    | Use Case                       | Cost | Speed  |
| :---------- | :----------------------------- | :--- | :----- |
| `gemini31p` | Pro with reasoning, 1M context | $$$  | Medium |

## DeepSeek Models

| Model ID    | Use Case            | Cost | Speed  |
| :---------- | :------------------ | :--- | :----- |
| `deepseek`  | V3.2 chat mode      | $    | Fast   |
| `deepseekT` | V3.2 with reasoning | $    | Medium |
| `dsr1`      | Advanced reasoning  | $$   | Medium |

## Moonshot Kimi Models

| Model ID  | Use Case                | Cost | Speed  |
| :-------- | :---------------------- | :--- | :----- |
| `kimi26T` | K2.6 with thinking mode | $$$  | Medium |
| `kimi26`  | K2.6, agent tasks       | $$$  | Medium |

## DashScope Qwen Models

| Model ID    | Use Case                    | Cost | Speed  |
| :---------- | :-------------------------- | :--- | :----- |
| `qwenplus`  | Hybrid thinking, 1M context | $$   | Medium |
| `qwenturbo` | Fast with optional thinking | $    | Fast   |

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

- **Simple tasks**: Fast, cheap models (`qwenturbo`, `deepseek`, `haiku45`)
- **Complex tasks**: Powerful models (`opus47`, `gpt55`, `gemini31p`)
- **Code-heavy / LaTeX editing**: Strong editing models (`opus47T`, `sonnet46T`, `qwenplus`)
- **Reasoning-heavy**: Thinking models (`opus47T`, `sonnet46T`, `deepseekT`, `kimi26T`)
- **Large documents**: High-context models (`gemini31p`, `sonnet46`, `opus47`)

## Configuration

Customize available models in VS Code Settings under `texra.models`:

```json
"texra.models": [
  "gemini31p",
  "sonnet46T",
  "opus47T",
  "gpt55",
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
