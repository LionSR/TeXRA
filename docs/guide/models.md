# AI Models

TeXRA supports a variety of language models from different providers, allowing you to choose the best fit for your task's complexity, required speed, and budget. This guide provides an overview of the models available by default.

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

| Model ID    | Key Strength / Use Case                     | Relative Cost | Relative Speed | Notes                        |
| :---------- | :------------------------------------------ | :------------ | :------------- | :--------------------------- |
| `opus`      | Highest quality, complex tasks              | $$$$          | Slow           |                              |
| `sonnet37`  | Strong all-rounder, good context            | $$$           | Medium         |                              |
| `sonnet37T` | `sonnet37` with explicit reasoning steps    | $$$           | Medium         | Good for math, complex logic |
| `sonnet35`  | Good balance of quality/cost (older Sonnet) | $$$           | Medium         |                              |

### OpenAI Models

Known for strong reasoning and creative capabilities.

| Model ID | Key Strength / Use Case            | Relative Cost | Relative Speed | Notes               |
| :------- | :--------------------------------- | :------------ | :------------- | :------------------ |
| `o1`     | Advanced reasoning, math, figures  | $$$$          | Slow           | Explicit reasoning  |
| `gpt45`  | High quality, vision (Preview)     | $$$$          | Medium         |                     |
| `gpt4o`  | Strong all-rounder, vision         | $$$           | Medium         | Good default choice |
| `gpt4ol` | Latest `gpt4o`, potentially better | $$$           | Medium         |                     |
| `o3-`    | Fast reasoning                     | $$$           | Fast           | `o3-mini`           |
| `o1-`    | Fast reasoning (smaller `o1`)      | $$$           | Fast           | `o1-mini`           |

### Google Models

Known for large context windows, multimodality, and speed/cost efficiency.

| Model ID    | Key Strength / Use Case                    | Relative Cost | Relative Speed | Notes                                   |
| :---------- | :----------------------------------------- | :------------ | :------------- | :-------------------------------------- |
| `gemini25p` | Strong reasoning, vision, large context    | $$$           | Medium         | Latest Pro model                        |
| `gemini2p`  | Good reasoning, vision, very large context | $$            | Medium         |                                         |
| `gemini25f` | Fast reasoning, large context              | $$            | Fast           | Latest Flash model                      |
| `gemini2fT` | `gemini2f` with explicit reasoning steps   | $             | Fast           |                                         |
| `gemini2f`  | Fastest, most cost-effective, vision       | $             | Very Fast      | Good for simple tasks, native PDF/audio |

### Other Models (via OpenRouter)

These require enabling OpenRouter in settings.

| Model ID | Key Strength / Use Case              | Relative Cost | Relative Speed | Notes            |
| :------- | :----------------------------------- | :------------ | :------------- | :--------------- |
| `grok3`  | Large context, alternative reasoning | $$$           | Medium         | xAI Grok 3       |
| `grok3-` | Faster Grok 3 (mini)                 | $$            | Fast           | xAI Grok 3 Mini  |
| `DSV3`   | Strong technical/coding performance  | $             | Fast           | DeepSeek V3 Chat |
| `DSR1`   | Advanced reasoning (DeepSeek)        | $$            | Medium         | DeepSeek R1      |

_Relative Cost/Speed are estimates: $ = Low/Fast, $$$$ = High/Slow._

## Choosing the Right Model

Consider these factors:

- **Task Complexity**: Simple corrections might only need a `$`/Fast model (`gemini2f`), while complex paper transformations benefit from `$$$$`/Slow models (`opus`, `o1`).
- **Budget**: Use cost indicators ($ - $$$$) to guide selection.
- **Speed**: If quick turnaround is needed, prefer Fast/Very Fast models.
- **Special Capabilities**: Do you need explicit reasoning (`sonnet37T`, `gemini2fT`, `o1`, `o3-`, `o1-`, `DSR1`), vision (`gpt4o`, `gemini*`), native PDF/audio (`gemini*`), or very large context (`gemini*`)?

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
  "sonnet35",
  "opus",
  "o3-",
  "o1",
  "o1-",
  "gpt45",
  "gpt4o",
  "gpt4ol",
  "gemini25p",
  "gemini25f",
  "gemini2p",
  "gemini2f",
  "gemini2fT",
  "DSV3",
  "DSR1",
  "grok3",
  "grok3-"
]
```

## Using OpenRouter

To access models not directly integrated (like Grok or DeepSeek) or potentially find different pricing:

1.  Get an [OpenRouter](https://openrouter.ai/) API key.
2.  Add the key using the `TeXRA: Set API Key` command (select OpenRouter).
3.  Enable OpenRouter in VS Code Settings: `"texra.model.useOpenRouter": true`.

When enabled, TeXRA will route API calls through OpenRouter for compatible models.

## Next Steps

- [Built-in Agents](./built-in-agents.md): See which agents work well with different models.
- [Configuration](./configuration.md): Learn about other model-related settings like streaming.
