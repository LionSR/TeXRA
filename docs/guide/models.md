<script setup>
import ModelPickerHero from '../.vitepress/components/ModelPickerHero.vue';
import ProviderConfigRow from '../.vitepress/components/ProviderConfigRow.vue';
import ModelChoiceMatrix from '../.vitepress/components/ModelChoiceMatrix.vue';
import CliModelsHero from '../.vitepress/components/CliModelsHero.vue';
</script>

# AI models

TeXRA connects directly to frontier reasoning models from leading providers—including Anthropic, OpenAI, Google, DeepSeek, Moonshot, and DashScope. You can assign flagship reasoning models to demanding mathematical proofs and autonomous loops, while reserving faster, cost-efficient variants for routine document polish and formatting. Select a model from the dropdown menu in the TeXRA UI or pass `--model` in the CLI. Hover over any option to inspect its context window and pricing.

<ModelPickerHero />

<p class="hero-caption">The model picker: one entry per model, named by its model reference, with a <code>T</code> badge on models that think, and a hover popover showing context window and per-1M token pricing.</p>

**Model references.** A model is named `provider/id`, where `id` is the provider's own API model ID: `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol`. Wherever you type a model (an agent's `model`, `--model`, or `.texra/config.json`), you can add:

- `@effort` to set the reasoning effort: `@low`, `@medium`, `@high`, `@xhigh`, or `@max` (for example `anthropic/claude-opus-5-5@high`)
- `@none` to turn thinking off, on models that allow it (for example `deepseek/deepseek-v4-pro@none`)
- `+pro` to run an OpenAI model in pro reasoning mode (for example `openai/gpt-5.6-sol+pro`)

Thinking and non-thinking versions of a model are one entry, not separate models. Without an `@effort`, TeXRA uses the level you last saved for that model, otherwise **medium**, for every model. If a model does not offer the level you ask for, TeXRA uses the nearest level it does offer (a tie goes to the higher level, so `medium` on a model with only `low`, `high`, and `max` runs at `high`), and the run log says so. Old short names such as `opus55` or `sonnet5T` are still accepted when you type them, but the reference is the canonical name.

## Anthropic models

| Model                                 | Use Case                                  | Cost | Speed  |
| :------------------------------------ | :---------------------------------------- | :--- | :----- |
| `anthropic/claude-fable-5-1`          | Most capable, always-on adaptive thinking | $$$$ | Slow   |
| `anthropic/claude-opus-5-5`           | Long-running agentic work                 | $$$  | Medium |
| `anthropic/claude-sonnet-5-5`         | All-rounder, always-on adaptive thinking  | $$$  | Medium |
| `anthropic/claude-haiku-4-5-20251001` | Fast; `@none` for fastest responses       | $$   | Fast   |

Fable 5.1, Opus 5.5, and Sonnet 5.5 (and the older Opus 4.6 through Opus 5, Sonnet 4.6, and Sonnet 5) include the full 1M context window at standard pricing, with no opt-in or
beta header required. Haiku 4.5, Opus 4.5, and Sonnet 4.5 use a 200K context window.

Claude Fable 5.1 (`anthropic/claude-fable-5-1`) is Anthropic's most capable model. Thinking is always on (adaptive, with summarized reasoning), so it does not take `@none`. It supports the full reasoning-effort range up to `@xhigh` and the top `@max` tier, and is eligible for context compaction in tool-use mode.

Claude Sonnet 5.5 (`anthropic/claude-sonnet-5-5`) costs $2 / $10 per 1M tokens with a 1M context window. Thinking is always on (adaptive), so it does not take `@none`. It supersedes Sonnet 5 (`anthropic/claude-sonnet-5`), which is now deprecated.

Claude Opus 5.5 (`anthropic/claude-opus-5-5`) is built for long-running agentic coding and knowledge work at $4 / $20 per 1M tokens, below Opus 5. Like Fable 5.1, thinking is always on, and it accepts the full effort range up to `@max`.

TeXRA's reasoning-effort selector maps to Anthropic's effort levels automatically: pick `anthropic/claude-opus-5-5` with Extra High (`@xhigh`) or the top Max tier (`@max`) for the strongest agentic coding and long-horizon tasks. Opus 5.5 reads dense charts, diagrams, and screenshots more precisely than earlier models. TeXRA downscales images above `texra.maxImageDimension` (default 2000px) before sending, so raise that setting to send higher-resolution figures.

## OpenAI models

| Model                  | Use Case                 | Cost | Speed |
| :--------------------- | :----------------------- | :--- | :---- |
| `openai/gpt-6-astra`   | Most capable, 1M context | $$$$ | Fast  |
| `openai/gpt-6.1-sol`   | Agentic coding           | $$$  | Fast  |
| `openai/gpt-6-luna`    | Budget reasoning         | $    | Fast  |
| `openai/gpt-5.6-sol`   | Previous flagship        | $$$$ | Fast  |
| `openai/gpt-5.6-terra` | Lower-cost reasoning     | $$$  | Fast  |

GPT-6 Astra (`openai/gpt-6-astra`) is OpenAI's most capable model for the hardest end-to-end work; it is
available in the API and in Codex for Pro, Enterprise, and Business Premium subscribers, and
supports reasoning effort up to `@max`.
Note its long-context pricing: prompts above 272K input tokens bill at 2x input/cache and 1.5x
output for the full request.

GPT-6.1 Sol (`openai/gpt-6.1-sol`) and GPT-6 Luna (`openai/gpt-6-luna`) bring Astra's advances to faster, cheaper models: Sol costs $2 / $10 per 1M tokens (half of GPT-5.6 Sol) and Luna $0.10 / $0.50 (half of GPT-5.6 Luna on input, less than half on output). Both take reasoning effort up to `@max` and use the same long-context pricing as Astra. GPT-6.1 Sol supersedes GPT-6 Sol (`openai/gpt-6-sol`) at the same price with cheaper cached input.

GPT-6 Sol and Luna supersede GPT-5.6 Sol (`openai/gpt-5.6-sol`) and Luna (`openai/gpt-5.6-luna`); GPT-5.6 Luna is now
deprecated. The [Codex integration](./agent-integrations.md#openai-codex) runs GPT-6.1 Sol unless you pick another model.
`openai/gpt-5.6-terra` (Terra) remains a mid-priced option.

**Pro mode.** Add `+pro` to a GPT model (for example `openai/gpt-5.6-sol+pro`) to run it in the Responses API's pro reasoning mode, billed at standard token rates
rather than a premium tier, for the hardest planning and long-horizon tasks. Pro mode needs a direct OpenAI route; it is refused through OpenRouter. For one-off hard questions you can
also enable the `inquiry` tool and paste the answer from your own ChatGPT subscription instead of
running a full agent turn against the API.

**Fast processing.** Set `"texra.model.openaiFastTier": true` in `.texra/config.json` to send OpenAI requests on OpenAI's fast service tier, for models that offer it. Responses come back faster at a higher per-token price (for example $4 / $20 per 1M tokens for GPT-6.1 Sol), and run costs use the fast-tier prices. Read the [OpenAI API reference](https://developers.openai.com/api/docs) for
full capabilities.

GPT-5 reasoning summaries require account verification. Enable them with `texra.model.gpt5ReasoningSummary`.

## Google models

| Model                           | Use Case                       | Cost | Speed  |
| :------------------------------ | :----------------------------- | :--- | :----- |
| `google/gemini-3.1-pro-preview` | Pro with reasoning, 1M context | $$$  | Medium |
| `google/gemini-3.8-flash`       | Flash model with 1M context    | $$   | Fast   |

## DeepSeek models

| Model                      | Use Case                          | Cost | Speed  |
| :------------------------- | :-------------------------------- | :--- | :----- |
| `deepseek/deepseek-flash`  | V4.1 Flash; `@none` for chat mode | $    | Medium |
| `deepseek/deepseek-v4-pro` | V4 Pro; `@none` for chat mode     | $    | Medium |

DeepSeek offers `low`, `high`, and `max` effort, so the medium default runs at `high`.

## Moonshot Kimi models

| Model              | Use Case                | Cost | Speed  |
| :----------------- | :---------------------- | :--- | :----- |
| `moonshot/kimi-k3` | K3 flagship, 1M context | $$$  | Medium |

## DashScope Qwen models

| Model                         | Use Case                    | Cost | Speed  |
| :---------------------------- | :-------------------------- | :--- | :----- |
| `dashscope/qwen-plus`         | Hybrid thinking, 1M context | $$   | Medium |
| `dashscope/qwen-turbo-latest` | Fast with optional thinking | $    | Fast   |

## MiniMax models

| Model                | Use Case                                       | Cost | Speed  |
| :------------------- | :--------------------------------------------- | :--- | :----- |
| `minimax/MiniMax-M3` | Flagship with interleaved thinking, 1M context | $    | Medium |

MiniMax uses interleaved thinking (chain-of-thought woven into responses). API keys are region-specific: international keys (api.minimax.io) and China keys (api.minimax.cn) are not interchangeable. Expand the MiniMax row in **Models → API keys** and toggle **MiniMax China region** (GLM, Kimi/Moonshot, and Qwen have matching toggles; GLM's is on by default).

- **International**: Get your API key at [platform.minimax.io](https://platform.minimax.io/)
- **China**: Get your API key at [platform.minimaxi.com](https://platform.minimaxi.com/)
- **Coding Plan**: MiniMax offers monthly subscription plans ($10/$20/$50/mo) as an alternative to pay-as-you-go. Coding Plan keys are **not interchangeable** with standard API keys; enter your Coding Plan key through **Set API key** as usual. [Subscribe to the MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan).

## GLM (Zhipu AI / Z.AI) models

| Model             | Use Case                                     | Cost | Speed  |
| :---------------- | :------------------------------------------- | :--- | :----- |
| `glm/glm-5.3`     | Flagship, 1M context, reasoning-effort tiers | $$   | Medium |
| `glm/glm-5-turbo` | Fast inference, agent-optimized              | $$$  | Medium |

GLM models support thinking mode (reasoning is shown inline). TeXRA uses the
Responses API each region serves at `/api/v1`.

- **International (Z.AI)**: Get your API key at [z.ai](https://z.ai/); endpoint: api.z.ai
- **China (BigModel)**: Get your API key at [open.bigmodel.cn](https://open.bigmodel.cn/); endpoint: open.bigmodel.cn (default)
- **Coding Plan**: GLM offers monthly subscription plans as an alternative to pay-as-you-go, with access to all GLM models. A Coding Plan key uses the same endpoint as an API key in its region. Turn on the **Coding Plan** toggle on the GLM row of the Models page. [Subscribe to the GLM Coding Plan](https://z.ai/subscribe).

## Meta (Muse Spark) models

| Model                 | Use Case                                | Cost | Speed  |
| :-------------------- | :-------------------------------------- | :--- | :----- |
| `meta/muse-spark-1.3` | Flagship reasoning + vision, 1M context | $$   | Medium |
| `meta/muse-spark-1.1` | Reasoning + vision + PDF, 1M context    | $$   | Medium |

Muse Spark always reasons (effort is adjustable, but it does not take `@none`). TeXRA
uses the Meta Model API's Responses surface, which carries reasoning across
turns and supports tool calling. The API is in public preview for US-based
developers.

- Get your API key at [dev.meta.ai](https://dev.meta.ai/) (Model API dashboard → API keys tab)

## Grok / xAI models

| Model          | Use Case           | Cost | Speed  |
| :------------- | :----------------- | :--- | :----- |
| `xai/grok-4.7` | Reasoning + vision | $$$  | Medium |

Direct xAI models (API key or Grok subscription) use xAI's Responses API. xAI
keeps each response for 30 days, so a tool-use round sends only the new turn
rather than the whole conversation.

Every direct provider route uses its vendor's Responses API (or Anthropic's
and Google's own APIs); only OpenRouter still uses Chat Completions.

## Choosing a model

<ModelChoiceMatrix />

<p class="hero-caption">Pick a model by intent: each use case maps to a short list of recommended model references.</p>

## Setting API keys

### Subscription-backed models in VS Code

The VS Code extension can also use compatible models from a GitHub Copilot
subscription. Open **Settings → Models → Subscriptions → Copilot in VS Code**, then select
**Grant access**. VS Code shows its own consent prompt; TeXRA never asks for
or stores a Copilot API key.

Copilot models appear only in the VS Code extension because the official
Language Model API is an editor capability. They do not appear in the CLI or
desktop model lists. If Copilot quota is exhausted, the retry panel can start a
new run through the corresponding provider model once a usable provider API
key is available.

Using your own provider API key? TeXRA stores keys in `~/.texra/secrets/`, a folder only your user can read, shared by the extension, the desktop app and the CLI; they are never written to settings files.

1.  **Open Settings**: Select the <wa-icon library="texra" name="settings-gear"></wa-icon> gear icon in the TeXRA panel header, or run **TeXRA: Open Settings** from the Command Palette.
2.  **Go to the Models page**: The **API keys** list shows every provider with its current key status (`Set`, `Env`, or `Not set`).
3.  **Set the key**: Find your provider's row and select the <wa-icon library="texra" name="key"></wa-icon> **Set API key** button, then paste your key. If you don't have a key yet, select the <wa-icon library="texra" name="arrow-up-right-from-square"></wa-icon> **Get** button to open the provider's API key page.

The Status column shows `Set` once the key is stored. To replace a key, set it again; to remove one, select the <wa-icon library="texra" name="trash"></wa-icon> trash icon. Repeat for each provider you plan to use.

<ApiKeysHero />

<p class="hero-caption">The Models page's API keys list: each provider shows its key status and Set / Get / Remove actions.</p>

::: tip Per-provider settings
Expand a provider's row (select the chevron) to point requests at a custom endpoint, for providers that support it.
:::

You can also place a `.env` file in your workspace with variables such as `OPENAI_API_KEY`. TeXRA loads it automatically, so you don't need to enter keys each time.

Already paying for a ChatGPT or Grok subscription? Sign in and skip the API key for those models.
Kimi Code and the GLM Coding Plan also run on a subscription you already pay for, authenticated with a
plan-specific key instead of a full provider key. Read
[Quick start → Add a key or connect a subscription](./quick-start.md#add-a-key-or-connect-a-subscription).

The ChatGPT section's **Advanced → Input token budget** (`texra.chatgptCodex.contextWindowK`) is the
input budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, like Codex CLI's
`model_context_window`. The default 272 (272,000 tokens) matches Codex; GPT-5.6 models accept up to 872.
Automatic compaction may run earlier, according to the separate compaction threshold, and the context
window TeXRA displays adds the model's output budget. OpenAI enforces the real per-account limit: a value
above what your plan allows fails and triggers compaction recovery.

## Customizing the model list

Choose which models appear in the extension picker from **Settings → Models → Models**: toggle them on or off per provider, no JSON required (the choice is saved in the extension).

In the CLI TUI, run `/model` after a chat starts to see the models your current credentials can run. Mid-session switching is limited to models that share the active model's provider family; other entries are shown disabled with a reason, and switching waits until the current response finishes. To change family, start a new chat with `--model`. Before you send the first message, `/agent` chains straight into that same model picker, so choosing a root agent and its model stays one step.

For headless CLI runs, list what is available with `texra models list` (or `texra models show <model>` for details), then pick a default for your project by setting the `texra.model` key in `.texra/config.json`, or override per run with `--model <model>` (an `@effort` or `+pro` suffix works here too):

<CliModelsHero />

<p class="hero-caption">The first column is exactly what <code>--model</code> takes: the same model references used in the tables above. <code>--all</code> includes models your current credentials can't run, with the reason.</p>

## Using OpenRouter

To access additional models or alternative pricing:

1. Get an [OpenRouter](https://openrouter.ai/) API key
2. Add it with the `TeXRA: Set API Key` command
3. In Settings → Models → API keys, expand the OpenRouter row and turn on **Use OpenRouter for all models**

Expanding any provider's row in **API Configuration** reveals its key field plus the per-provider toggles described here:

<ProviderConfigRow />

<p class="hero-caption">Expand a provider's <strong>API keys</strong> row to reveal its masked key field (and <strong>Custom endpoint</strong> where supported); the OpenRouter row adds <strong>Use OpenRouter for all models</strong>.</p>

## Next steps

- [Built-in agents](./built-in-agents.md): see which agents work with which models
- [Configuration](./configuration.md): model-related settings
