# AI Models

TeXRA supports a variety of language models from different providers, allowing you to choose the best fit for your task's complexity, required speed, and budget (think of it as choosing your research assistant's brain!). This guide provides an overview of the models available by default.

## Model Providers Overview

TeXRA primarily integrates with models from:

1.  **Anthropic** (Claude family)
2.  **OpenAI** (GPT and O-series families)
3.  **Google** (Gemini family)
4.  **Other Providers** (via OpenRouter, including Grok, DeepSeek)

You can select the desired model from the dropdown list in the TeXRA UI.
Hovering over an option shows its provider, context window, and estimated cost.

## Default Model Selection

Here's a quick comparison of the models available by default in TeXRA:

### Anthropic Models

Known for strong instruction following and context handling.

| Model ID    | Key Strength / Use Case                     | Relative Cost | Relative Speed | Notes                           |
| :---------- | :------------------------------------------ | :------------ | :------------- | :------------------------------ |
| `opus45T`   | Latest Opus with explicit reasoning steps   | $$$$          | Slow           | Claude 4.5 Opus with thinking   |
| `opus45`    | Latest high quality, complex tasks          | $$$$          | Slow           | Claude 4.5 Opus                 |
| `opus41T`   | Previous-gen Opus with explicit reasoning   | $$$$          | Slow           | Claude 4.1 Opus with thinking   |
| `opus41`    | Previous-gen high quality, complex tasks    | $$$$          | Slow           | Claude 4.1 Opus                 |
| `opus4T`    | Opus 4 with explicit reasoning steps        | $$$$          | Slow           | Claude 4 Opus with thinking     |
| `opus4`     | Opus 4 high quality, complex tasks          | $$$$          | Slow           | Claude 4 Opus                   |
| `sonnet45T` | Latest Sonnet with explicit reasoning steps | $$$           | Medium         | Claude 4.5 Sonnet with thinking |
| `sonnet45`  | Latest strong all-rounder                   | $$$           | Medium         | Claude 4.5 Sonnet               |
| `sonnet4T`  | Sonnet 4 with explicit reasoning steps      | $$$           | Medium         | Claude 4 Sonnet with thinking   |
| `sonnet4`   | Sonnet 4 strong all-rounder                 | $$$           | Medium         | Claude 4 Sonnet                 |
| `sonnet37T` | `sonnet37` with explicit reasoning steps    | $$$           | Medium         | Good for math, complex logic    |
| `sonnet37`  | Strong all-rounder, good context            | $$$           | Medium         |                                 |
| `sonnet36`  | Claude 3.5 Sonnet (Oct 2024)                | $$$           | Medium         | 8k max output                   |
| `sonnet35`  | Good balance of quality/cost (older Sonnet) | $$$           | Medium         | Claude 3.5 Sonnet (June 2024)   |
| `opus3`     | Claude 3 Opus (legacy)                      | $$$$          | Slow           | 4k max output                   |
| `haiku45T`  | Fast Claude 4.5 with explicit reasoning     | $$            | Fast           | Claude 4.5 Haiku with thinking  |
| `haiku45`   | Fast Claude 4.5 responses                   | $$            | Fast           | Claude 4.5 Haiku                |
| `haiku35`   | Claude 3.5 Haiku                            | $             | Fast           | 8k max output, vision           |
| `haiku3`    | Claude 3 Haiku (legacy)                     | $             | Very Fast      | 8k max output, cheapest Claude  |

#### Sonnet 4 / 4.5 1M Context (Beta)

To experiment with Anthropic's 1M-token context window for Sonnet 4 or 4.5, enable `"texra.model.useAnthropic1MBeta": true` in VS Code settings. The extension attaches the `context-1m-2025-08-07` beta header for these requests. Only Sonnet 4-family models support this beta, and TeXRA still enforces the tier‑4 limit of 200 K tokens.

### OpenAI Models

Known for strong reasoning and creative capabilities.

| Model ID                | Key Strength / Use Case                | Relative Cost | Relative Speed | Notes                                    |
| :---------------------- | :------------------------------------- | :------------ | :------------- | :--------------------------------------- |
| `gpt52pro`              | Latest premium reasoning               | $$$$          | Slow           | GPT-5.2 Pro, 400k ctx, xhigh reasoning   |
| `gpt52`                 | Latest flagship reasoning              | $$$           | Medium         | GPT-5.2, 400k ctx, xhigh reasoning       |
| `gpt51`                 | Flagship reasoning w/ high effort      | $$$           | Medium         | GPT-5.1, 400k context, 128k max output   |
| `gpt5pro`               | Premium reasoning & coding             | $$$$          | Slow           | 400k ctx, 272k max output                |
| `gpt5`                  | Flagship reasoning & coding            | $$$           | Medium         | 400k context                             |
| `gpt5-`                 | Flagship mini, fast                    | $$            | Fast           | 400k context, mini                       |
| `gpt5--`                | Flagship nano, fastest                 | $             | Very Fast      | 400k context, nano                       |
| `gpt45`                 | High quality, vision (Preview)         | $$$$          | Medium         |                                          |
| `gpt41`                 | Long-context vision, powerful          | $$$           | Medium         | 1M tokens context                        |
| `gpt41-`                | Long-context vision, cost-effective    | $$            | Medium         | 1M tokens context, mini                  |
| `gpt41--`               | Long-context vision, cheapest          | $             | Medium         | 1M tokens context, nano                  |
| `gpt4o`                 | Strong all-rounder, vision             | $$$           | Medium         | Good default choice                      |
| `gpt4o-`                | Cost-effective all-rounder             | $             | Fast           | GPT-4o mini                              |
| `gpt4ol`                | Latest `gpt4o`, potentially better     | $$$           | Medium         | ChatGPT-4o Latest                        |
| `o4-`                   | Fast o4-mini reasoning                 | $$$           | Fast           | Vision, web search, code exec            |
| `o3pro`                 | Reliable answers, heavy compute        | $$$$          | Slow           | `o3-pro`                                 |
| `o3`                    | Coding, tool calling                   | $$$           | Medium         |                                          |
| `o3-`                   | Fast reasoning                         | $$$           | Fast           | `o3-mini`                                |
| `o1pro`                 | Premium o1 reasoning                   | $$$$          | Slow           | High-compute o1                          |
| `o1`                    | Advanced reasoning, math, figures      | $$$$          | Slow           | Explicit reasoning                       |
| `o1-`                   | Fast reasoning (smaller `o1`)          | $$$           | Fast           | `o1-mini`                                |
| `o3-deep-research`      | Deep research with web/code            | $$$$          | Slow           | Responses API only, 200k ctx             |
| `o4-mini-deep-research` | Cost-effective deep research           | $$$           | Medium         | Responses API only, 200k ctx             |
| `gptoss`                | Open-weight reasoning, large context   | $$            | Medium         | `gpt-oss-120b` (OpenRouter only)         |
| `gptoss-`               | Open-weight reasoning, cost-effective  | $             | Fast           | `gpt-oss-20b` (OpenRouter only)          |

> **Note:** GPT-5.2, GPT-5.1, GPT-5, and GPT-5 Pro reasoning summaries require additional account verification. TeXRA disables them by default--enable `"texra.model.gpt5ReasoningSummary": true` if your account supports this feature.

**GPT-5.2 highlights**

- Introduces `xhigh` reasoning effort for the most thorough analysis.
- GPT-5.2 Pro requires the Responses API and is suited for complex multi-step research.
- Same 400k context window and 128k max output as GPT-5.1/5.

**GPT-5.1 highlights**

- Default reasoning effort is `high`, supporting `low`, `medium`, and `high` effort levels.
- Shares GPT-5's 400k-token context window, 128k output ceiling, pricing, and predictive output support, so it is a drop-in upgrade for existing GPT-5 workflows.
- Supports OpenAI's `apply_patch` and `shell` tools for multi-step coding tasks; enable them through TeXRA's tool configuration if you rely on automated refactors.

### Google Models

Known for large context windows, multimodality, and speed/cost efficiency.

| Model ID     | Key Strength / Use Case                    | Relative Cost | Relative Speed | Notes                                   |
| :----------- | :----------------------------------------- | :------------ | :------------- | :-------------------------------------- |
| `gemini3p`   | Latest Pro with reasoning and code exec    | $$$           | Medium         | Gemini 3 Pro Preview, 1M context        |
| `gemini3f`   | Latest Flash with reasoning and code exec  | $$            | Fast           | Gemini 3 Flash Preview, 1M context      |
| `gemini25p`  | Strong reasoning, vision, large context    | $$$           | Medium         | Gemini 2.5 Pro, 1M context              |
| `gemini25f`  | Fast reasoning, large context              | $$            | Fast           | Gemini 2.5 Flash, 1M context            |
| `gemini25f-` | Budget flash, smaller context              | $             | Fast           | Gemini 2.5 Flash Lite, 64k context      |

### DeepSeek Models

Strong technical and coding performance, cost-effective. DeepSeek's API now
supports function calling so agents can use external tools during a run.

| Model ID     | Key Strength / Use Case               | Relative Cost | Relative Speed | Notes                                    |
| :----------- | :------------------------------------ | :------------ | :------------- | :--------------------------------------- |
| `deepseek`   | V3.2 non-thinking mode                | $             | Fast           | DeepSeek V3.2 Chat, 128k context         |
| `deepseekT`  | V3.2 with reasoning (thinking mode)   | $             | Medium         | DeepSeek V3.2 Reasoner, 163k context     |
| `deepseekT+` | V3.2 extended thinking (Speciale)     | $             | Slow           | Extended reasoning, 131k max output      |
| `dsv3`       | Good coding & general tasks           | $             | Fast           | DeepSeek V3 Chat (0324), 128k context    |
| `dsr1`       | Advanced reasoning                    | $$            | Medium         | DeepSeek R1 (0528), 128k context         |

### Moonshot Kimi Models

High context models from Moonshot, suitable for complex reasoning and large documents.

**Kimi K2** is Moonshot's open-source 1T-parameter MoE model (32B active).
It excels at coding and agentic tasks. The 0905 preview offers a 256k context window,
with turbo variants for faster inference and thinking variants for enhanced reasoning.

| Model ID  | Key Strength / Use Case            | Relative Cost | Relative Speed | Notes                                               |
| :-------- | :--------------------------------- | :------------ | :------------- | :-------------------------------------------------- |
| `kimit`   | Detailed reasoning with vision     | $$$           | Medium         | Kimi Thinking Preview, 128k context                 |
| `kimi`    | Large context, general tasks       | $$            | Medium         | 128k context                                        |
| `kimiv`   | Vision-enabled variant             | $$            | Medium         | 128k context, vision                                |
| `kimi2`   | Agent tasks, 256k context          | $$$           | Medium         | Kimi K2 0905 Preview (`moonshotai/kimi-k2-0905`)    |
| `kimi2+`  | Fast agent tasks                   | $$$$          | Very Fast      | Kimi K2 Turbo Preview (`moonshotai/kimi-k2-turbo`)  |
| `kimi2T`  | K2 with thinking mode              | $$            | Medium         | Kimi K2 Thinking, interleaved reasoning             |
| `kimi2T+` | Fast K2 with thinking mode         | $$$           | Fast           | Kimi K2 Thinking Turbo                              |

The earlier Kimi K2 0711 model remains available on OpenRouter as `moonshotai/kimi-k2`.

Additional resources: [API](https://platform.moonshot.ai) –
$0.15/million input tokens (cache hit), $0.60/million input tokens (cache
miss), $2.50/million output tokens. [Tech blog](https://moonshotai.github.io/Kimi-K2/),
[Weights & code](https://huggingface.co/moonshotai),
[GitHub](https://github.com/MoonshotAI/Kimi-K2).

### DashScope Qwen Models

Cost-effective models from Alibaba with strong multilingual capabilities.

| Model ID    | Key Strength / Use Case                    | Relative Cost | Relative Speed | Notes                              |
| :---------- | :----------------------------------------- | :------------ | :------------- | :--------------------------------- |
| `qwen3max`  | Flagship coding agent, 262k ctx            | $$$           | Medium         | Qwen3-Max latest, no thinking mode |
| `qwenplus`  | Hybrid thinking, 1M ctx + tool use         | $$            | Medium         | Qwen Plus latest, enable_thinking  |
| `qwenturbo` | Fast responses with optional thinking mode | $             | Fast           | Qwen Turbo, enable_thinking        |

Deep thinking models first stream their reasoning before the final answer.
`qwenplus` and `qwenturbo` support this mode. Pass `enable_thinking: true`
in the request body to turn it on; commercial tiers disable it by default.
`qwen3max` always runs in non-thinking mode.

```python
from openai import OpenAI
import os

client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
)

resp = client.chat.completions.create(
    model="qwen-plus-latest",
    messages=[{"role": "user", "content": "Who are you?"}],
    extra_body={"enable_thinking": True},
)
print(resp.choices[0].message.reasoning_content)
print(resp.choices[0].message.content)
```

Use the `thinking_budget` parameter to cap how many tokens the reasoning step
can consume.

### Copilot Models

GitHub Copilot models are available through VS Code's built-in Language Model API.
These models require user consent and sign in to GitHub Copilot.

| Model ID    | Key Strength / Use Case    | Relative Cost | Relative Speed | Notes               |
| :---------- | :------------------------- | :------------ | :------------- | :------------------ |
| `copilot4o` | Strong all-rounder, vision | $$            | Medium         | Uses GPT-4o backend |

### Grok / xAI Models

Large context models from xAI.

| Model ID | Key Strength / Use Case               | Relative Cost | Relative Speed | Notes                                    |
| :------- | :------------------------------------ | :------------ | :------------- | :--------------------------------------- |
| `grok4`  | Very large context, strong reasoning  | $$$           | Medium         | xAI Grok 4, 256k ctx, reasoning          |
| `grok3`  | Large context, alternative reasoning  | $$$           | Medium         | xAI Grok 3, 131k ctx                     |
| `grok3-` | Faster Grok 3 with reasoning          | $$            | Fast           | xAI Grok 3 Mini, reasoning effort: low   |
| `grok2`  | Grok 2 general purpose                | $$            | Medium         | 131k context                             |
| `grok2v` | Grok 2 with vision                    | $$            | Medium         | 32k context, vision-enabled              |

### Other Models (Available Primarily via OpenRouter)

These models are generally accessed by enabling OpenRouter in settings.

| Model ID  | Key Strength / Use Case          | Provider     | Relative Cost | Relative Speed |
| :-------- | :------------------------------- | :----------- | :------------ | :------------- |
| `llama31` | Strong open model, large context | Meta         | $$$           | Medium         |
| `qvq-72b` | Strong multi-lingual             | Qwen/Alibaba | $$            | Medium         |

_Relative Cost/Speed are estimates: $ = Low/Fast, $$$$ = High/Slow._

## Choosing the Right Model

Consider these factors:

- **Task Complexity**: Simple corrections might only need a `$`/Fast model (`gemini25f-`, `gpt5--`), while complex paper transformations benefit from `$$$$`/Slow models (`opus45`, `gpt52pro`, `o1`).
- **Budget**: Use cost indicators ($ - $$$$) to guide selection.
- **Speed**: If quick turnaround is needed, prefer Fast/Very Fast models.
- **Special Capabilities**: Do you need explicit reasoning (`sonnet45T`, `sonnet37T`, `gemini3p`, `o1`, `o3`, `deepseekT`, `dsr1`, `kimi2T`), vision (`gpt52`, `gpt5`, `gpt4o`, `gemini*`, `grok2v`), native PDF/audio (`gemini*`), or very large context (`gemini*`, `gpt41`, `gpt52`, `gpt5`)?

Experimentation is often key to finding the best model for your specific needs and writing style.

## Model Configuration

You can customize which models appear in the TeXRA dropdown list via VS Code Settings (`Ctrl+,`). Search for `texra.models` and edit the JSON array. Here are the defaults:

::: tip Model Availability
The specific models available by default and their identifiers (`sonnet45`, `gpt51`, `gpt5`, `gpt5pro`, etc.) are maintained by the TeXRA developers and may change in future updates based on new releases and performance evaluations.
:::

```json
"texra.models": [
  "gemini3p",
  "sonnet45T",
  "opus45T",
  "gpt52",
  "gpt51",
  "gpt41",
  "deepseekT",
  "kimi2T",
  "qwen3max",
  "grok4"
]
```

### Instruction Polishing Model

TeXRA also uses a dedicated setting for polishing instruction text before an agent run. Set
`"texra.model.instructionPolishModel"` to any short name from the enum (same as `texra.models`) to pick the model that
handles this formatting step when Copilot is disabled. The default is `sonnet45`.

```json
"texra.model.instructionPolishModel": "sonnet45"
```

This setting is independent from the dropdown list—use it to lock polishing to a stable model while you
experiment with other agents. The setting accepts any model from the same enum as `texra.models`, ensuring
you can only select valid models.

## Using OpenRouter

To access models not directly integrated (like Llama or Qwen), find alternative pricing, or ensure access if a direct API key isn't available, you can use [OpenRouter](https://openrouter.ai/).

1.  Get an [OpenRouter](https://openrouter.ai/) API key.
2.  Add the key using the `TeXRA: Set API Key` command (select OpenRouter).
3.  Enable OpenRouter in VS Code Settings: `"texra.model.useOpenRouter": true`.

When enabled, TeXRA will route API calls **for all compatible models** (including Anthropic, OpenAI, Google, DeepSeek, Grok, etc., if supported by OpenRouter) through OpenRouter instead of their direct APIs.

## Streaming Support

For long responses or reasoning-heavy models, you can enable streaming to see incremental results. This is often more robust for complex tasks.

Configure streaming in VS Code Settings:

```json
// General streaming toggle (applies if specific model type toggle isn't set)
"texra.model.useStreaming": false,

// Specific toggle for Anthropic reasoning models
"texra.model.useStreamingAnthropicReasoning": false,

// Specific toggle for OpenAI reasoning models
"texra.model.useStreamingOpenAIReasoning": false,

// Specific toggle for Google models
"texra.model.useStreamingGoogle": false

// Similar configuration exists for DeepSeek and OpenRouter models
```

## Next Steps

- [Built-in Agents](./built-in-agents.md): See which agents work well with different models.
- [Configuration](./configuration.md): Learn about other model-related settings like streaming.
- [OpenAI Responses API](./openai-responses-api.md): Overview of the new API used when `useOpenAIResponsesAPI` is enabled.
