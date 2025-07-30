# AI Models

TeXRA supports a variety of language models from different providers, allowing you to choose the best fit for your task's complexity, required speed, and budget (think of it as choosing your research assistant's brain!). This guide provides an overview of the models available by default.

## Model Providers Overview

TeXRA primarily integrates with models from:

1.  **Anthropic** (Claude family)
2.  **OpenAI** (GPT and O-series families)
3.  **Google** (Gemini family)
4.  **Other Providers** (via OpenRouter, including Grok, DeepSeek)

You can select the desired model from the dropdown list in the TeXRA UI.

## Default Model Selection

Here's a quick comparison of the models available by default in TeXRA:

### Anthropic Models

Known for strong instruction following and context handling.

| Model ID    | Key Strength / Use Case                     | Relative Cost | Relative Speed | Notes                         |
| :---------- | :------------------------------------------ | :------------ | :------------- | :---------------------------- |
| `opus4T`    | Latest Opus with explicit reasoning steps   | $$$$          | Slow           | Claude 4 Opus with thinking   |
| `opus4`     | Latest high quality, complex tasks          | $$$$          | Slow           | Claude 4 Opus                 |
| `sonnet4T`  | Latest Sonnet with explicit reasoning steps | $$$           | Medium         | Claude 4 Sonnet with thinking |
| `sonnet4`   | Latest strong all-rounder                   | $$$           | Medium         | Claude 4 Sonnet               |
| `sonnet37T` | `sonnet37` with explicit reasoning steps    | $$$           | Medium         | Good for math, complex logic  |
| `sonnet37`  | Strong all-rounder, good context            | $$$           | Medium         |                               |
| `sonnet35`  | Good balance of quality/cost (older Sonnet) | $$$           | Medium         |                               |

### OpenAI Models

Known for strong reasoning and creative capabilities.

| Model ID  | Key Strength / Use Case             | Relative Cost | Relative Speed | Notes                   |
| :-------- | :---------------------------------- | :------------ | :------------- | :---------------------- |
| `o1`      | Advanced reasoning, math, figures   | $$$$          | Slow           | Explicit reasoning      |
| `gpt45`   | High quality, vision (Preview)      | $$$$          | Medium         |                         |
| `gpt41`   | Long-context vision, powerful       | $$$           | Medium         | 1M tokens context       |
| `gpt41-`  | Long-context vision, cost-effective | $$            | Medium         | 1M tokens context, mini |
| `gpt41--` | Long-context vision, cheapest       | $             | Medium         | 1M tokens context, nano |
| `gpt4o`   | Strong all-rounder, vision          | $$$           | Medium         | Good default choice     |
| `gpt4ol`  | Latest `gpt4o`, potentially better  | $$$           | Medium         |                         |
| `o3`      | Coding, tool calling                | $$$           | Medium         |                         |
| `o3pro`   | Reliable answers, heavy compute     | $$$$          | Slow           | `o3-pro`                |
| `o3-`     | Fast reasoning                      | $$$           | Fast           | `o3-mini`               |
| `o1-`     | Fast reasoning (smaller `o1`)       | $$$           | Fast           | `o1-mini`               |

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

| Model ID | Key Strength / Use Case        | Relative Cost | Relative Speed | Notes                 |
| :------- | :----------------------------- | :------------ | :------------- | :-------------------- |
| `kimit`  | Detailed reasoning with vision | $$$           | Medium         | Kimi Thinking Preview |
| `kimi`   | Large context, general tasks   | $$            | Medium         | 128k context          |
| `kimiv`  | Vision-enabled variant         | $$            | Medium         | 128k context, vision  |
| `kimi2`  | Agent tasks                    | $$$           | Medium         | Kimi K2 0711 Preview  |

### DashScope Qwen Models

Cost-effective models from Alibaba with strong multilingual capabilities.

| Model ID    | Key Strength / Use Case       | Relative Cost | Relative Speed | Notes      |
| :---------- | :---------------------------- | :------------ | :------------- | :--------- |
| `qwenmax`   | Advanced reasoning            | $$            | Medium         | Qwen Max   |
| `qwenplus`  | Large context general purpose | $$            | Medium         | Qwen Plus  |
| `qwenturbo` | Fast responses                | $             | Fast           | Qwen Turbo |

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
- **Special Capabilities**: Do you need explicit reasoning (`sonnet37T`, `gemini2fT`, `o1`, `o3-`, `o1-`, `dsr1`), vision (`gpt4o`, `gemini*`), native PDF/audio (`gemini*`), or very large context (`gemini*`, `gpt41`)?

Experimentation is often key to finding the best model for your specific needs and writing style.

## Model Configuration

You can customize which models appear in the TeXRA dropdown list via VS Code Settings (`Ctrl+,`). Search for `texra.models` and edit the JSON array. Here are the defaults:

::: tip Model Availability
The specific models available by default and their identifiers (`sonnet37`, `gpt4o`, etc.) are maintained by the TeXRA developers and may change in future updates based on new releases and performance evaluations.
:::

```json
"texra.models": [
  "sonnet37T",
  "sonnet37",
  "o3",
  "o4-",
  "o3-",
  "o1",
  "gpt41",
  "gpt4o",
  "gemini25p",
  "gemini25f",
  "gemini2fT",
  "dsv3",
  "dsr1",
  "grok4",
  "grok3",
  "qwenplus",
  "kimit",
  "kimiv",
  "kimi2",
  "copilot4o"
]
```

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
