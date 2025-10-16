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
| `opus41T`   | Latest Opus with explicit reasoning steps   | $$$$          | Slow           | Claude 4.1 Opus with thinking   |
| `opus41`    | Latest high quality, complex tasks          | $$$$          | Slow           | Claude 4.1 Opus                 |
| `opus4T`    | Opus 4 with explicit reasoning steps        | $$$$          | Slow           | Claude 4 Opus with thinking     |
| `opus4`     | Opus 4 high quality, complex tasks          | $$$$          | Slow           | Claude 4 Opus                   |
| `sonnet45T` | Latest Sonnet with explicit reasoning steps | $$$           | Medium         | Claude 4.5 Sonnet with thinking |
| `sonnet45`  | Latest strong all-rounder                   | $$$           | Medium         | Claude 4.5 Sonnet               |
| `sonnet4T`  | Sonnet 4 with explicit reasoning steps      | $$$           | Medium         | Claude 4 Sonnet with thinking   |
| `sonnet4`   | Sonnet 4 strong all-rounder                 | $$$           | Medium         | Claude 4 Sonnet                 |
| `sonnet37T` | `sonnet37` with explicit reasoning steps    | $$$           | Medium         | Good for math, complex logic    |
| `sonnet37`  | Strong all-rounder, good context            | $$$           | Medium         |                                 |
| `sonnet35`  | Good balance of quality/cost (older Sonnet) | $$$           | Medium         |                                 |
| `haiku45T`  | Fast Claude 4.5 with explicit reasoning     | $$            | Fast           | Claude 4.5 Haiku with thinking  |
| `haiku45`   | Fast Claude 4.5 responses                   | $$            | Fast           | Claude 4.5 Haiku                |

#### Sonnet 4 / 4.5 1M Context (Beta)

To experiment with Anthropic's 1M-token context window for Sonnet 4 or 4.5, enable `"texra.model.useAnthropic1MBeta": true` in VS Code settings. The extension attaches the `context-1m-2025-08-07` beta header for these requests. Only Sonnet 4-family models support this beta, and TeXRA still enforces the tier‑4 limit of 200 K tokens.

### OpenAI Models

Known for strong reasoning and creative capabilities.

| Model ID  | Key Strength / Use Case               | Relative Cost | Relative Speed | Notes                            |
| :-------- | :------------------------------------ | :------------ | :------------- | :------------------------------- |
| `o1`      | Advanced reasoning, math, figures     | $$$$          | Slow           | Explicit reasoning               |
| `gpt45`   | High quality, vision (Preview)        | $$$$          | Medium         |                                  |
| `gpt5pro` | Premium reasoning & coding            | $$$$          | Slow           | 400k ctx, 272k max output        |
| `gpt5`    | Flagship reasoning & coding           | $$$           | Medium         | 400k context                     |
| `gpt5-`   | Flagship mini, fast                   | $$            | Fast           | 400k context, mini               |
| `gpt5--`  | Flagship nano, fastest                | $             | Very Fast      | 400k context, nano               |
| `gpt41`   | Long-context vision, powerful         | $$$           | Medium         | 1M tokens context                |
| `gpt41-`  | Long-context vision, cost-effective   | $$            | Medium         | 1M tokens context, mini          |
| `gpt41--` | Long-context vision, cheapest         | $             | Medium         | 1M tokens context, nano          |
| `gpt4o`   | Strong all-rounder, vision            | $$$           | Medium         | Good default choice              |
| `gpt4ol`  | Latest `gpt4o`, potentially better    | $$$           | Medium         |                                  |
| `o3`      | Coding, tool calling                  | $$$           | Medium         |                                  |
| `o3pro`   | Reliable answers, heavy compute       | $$$$          | Slow           | `o3-pro`                         |
| `o3-`     | Fast reasoning                        | $$$           | Fast           | `o3-mini`                        |
| `o1-`     | Fast reasoning (smaller `o1`)         | $$$           | Fast           | `o1-mini`                        |
| `gptoss`  | Open-weight reasoning, large context  | $$            | Medium         | `gpt-oss-120b` (OpenRouter only) |
| `gptoss-` | Open-weight reasoning, cost-effective | $             | Fast           | `gpt-oss-20b` (OpenRouter only)  |

> **Note:** GPT-5 and GPT-5 Pro reasoning summaries require additional account verification. TeXRA disables them by default—enable `"texra.model.gpt5ReasoningSummary": true` if your account supports this feature.

### Google Models

Known for large context windows, multimodality, and speed/cost efficiency.

| Model ID    | Key Strength / Use Case                    | Relative Cost | Relative Speed | Notes                                   |
| :---------- | :----------------------------------------- | :------------ | :------------- | :-------------------------------------- |
| `gemini25p` | Strong reasoning, vision, large context    | $$$           | Medium         | Latest Pro model                        |
| `gemini2p`  | Good reasoning, vision, very large context | $$            | Medium         |                                         |
| `gemini25f` | Fast reasoning, large context              | $$            | Fast           | Latest Flash model                      |
| `gemini2fT` | `gemini2f` with explicit reasoning steps   | $             | Fast           |                                         |
| `gemini2f`  | Fastest, most cost-effective, vision       | $             | Very Fast      | Good for simple tasks, native PDF/audio |

### DeepSeek Models

Strong technical and coding performance, cost-effective. DeepSeek's API now
supports function calling so agents can use external tools during a run.

| Model ID | Key Strength / Use Case     | Relative Cost | Relative Speed | Notes            |
| :------- | :-------------------------- | :------------ | :------------- | :--------------- |
| `dsv3`   | Good coding & general tasks | $             | Fast           | DeepSeek V3 Chat |
| `dsr1`   | Advanced reasoning          | $$            | Medium         | DeepSeek R1      |

### Moonshot Kimi Models

High context models from Moonshot, suitable for complex reasoning and large documents.

**Kimi K2** is Moonshot's open-source 1T‑parameter MoE model (32B active).
It excels at coding and agentic tasks but currently lacks multimodal and
thought-mode support. The 0905 preview offers a 256k context window, and a
high-speed turbo variant is also available.

| Model ID     | Key Strength / Use Case        | Relative Cost | Relative Speed | Notes                                              |
| :----------- | :----------------------------- | :------------ | :------------- | :------------------------------------------------- |
| `kimit`      | Detailed reasoning with vision | $$$           | Medium         | Kimi Thinking Preview                              |
| `kimi`       | Large context, general tasks   | $$            | Medium         | 128k context                                       |
| `kimiv`      | Vision-enabled variant         | $$            | Medium         | 128k context, vision                               |
| `kimi2`      | Agent tasks, 256k context      | $$$           | Medium         | Kimi K2 0905 Preview (`moonshotai/kimi-k2-0905`)   |
| `kimi2turbo` | Fast agent tasks               | $$$$          | Very Fast      | Kimi K2 Turbo Preview (`moonshotai/kimi-k2-turbo`) |

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

| Model ID | Key Strength / Use Case              | Relative Cost | Relative Speed | Notes           |
| :------- | :----------------------------------- | :------------ | :------------- | :-------------- |
| `grok4`  | Very large context, strong reasoning | $$$           | Medium         | xAI Grok 4      |
| `grok3`  | Large context, alternative reasoning | $$$           | Medium         | xAI Grok 3      |
| `grok3-` | Faster Grok 3 (mini)                 | $$            | Fast           | xAI Grok 3 Mini |

### Other Models (Available Primarily via OpenRouter)

These models are generally accessed by enabling OpenRouter in settings.

| Model ID  | Key Strength / Use Case          | Provider     | Relative Cost | Relative Speed |
| :-------- | :------------------------------- | :----------- | :------------ | :------------- |
| `llama31` | Strong open model, large context | Meta         | $$$           | Medium         |
| `qvq-72b` | Strong multi-lingual             | Qwen/Alibaba | $$            | Medium         |

_Relative Cost/Speed are estimates: $ = Low/Fast, $$$$ = High/Slow._

## Choosing the Right Model

Consider these factors:

- **Task Complexity**: Simple corrections might only need a `$`/Fast model (`gemini2f`), while complex paper transformations benefit from `$$$$`/Slow models (`opus`, `o1`).
- **Budget**: Use cost indicators ($ - $$$$) to guide selection.
- **Speed**: If quick turnaround is needed, prefer Fast/Very Fast models.
- **Special Capabilities**: Do you need explicit reasoning (`sonnet45T`, `sonnet37T`, `gemini2fT`, `o1`, `o3-`, `o1-`, `gptoss`, `gptoss-`, `dsr1`), vision (`gpt5`, `gpt5pro`, `gpt4o`, `gemini*`), native PDF/audio (`gemini*`), or very large context (`gemini*`, `gpt41`, `gpt5`, `gpt5pro`)?

Experimentation is often key to finding the best model for your specific needs and writing style.

## Model Configuration

You can customize which models appear in the TeXRA dropdown list via VS Code Settings (`Ctrl+,`). Search for `texra.models` and edit the JSON array. Here are the defaults:

::: tip Model Availability
The specific models available by default and their identifiers (`sonnet45`, `gpt5`, `gpt5pro`, etc.) are maintained by the TeXRA developers and may change in future updates based on new releases and performance evaluations.
:::

```json
"texra.models": [
  "gemini25p",
  "gemini25f",
  "opus41T",
  "sonnet45T",
  "sonnet4T",
  "gpt5",
  "gpt41",
  "deepseek",
  "deepseekT",
  "kimi2",
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
