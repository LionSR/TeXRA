<script setup>
import ModelPickerHero from '../.vitepress/components/ModelPickerHero.vue';
import ProviderConfigRow from '../.vitepress/components/ProviderConfigRow.vue';
import ModelChoiceMatrix from '../.vitepress/components/ModelChoiceMatrix.vue';
import CliModelsHero from '../.vitepress/components/CliModelsHero.vue';
</script>

# AI models

TeXRA supports models from multiple providers, so you can pick the strongest reasoning model for a derivation and a cheaper one for routine edits. Select a model from the dropdown in the TeXRA UI. Hover over an option to see its context window and cost estimate.

<ModelPickerHero />

<p class="hero-caption">The model picker: monospace model ids with a <code>T</code> badge on thinking variants, and a hover popover showing context window and per-1M token pricing.</p>

**Model ID suffixes:**

- `T` = thinking/reasoning mode enabled (shows chain-of-thought)
- `-` = lighter, faster variant
- Numbers indicate the version (for example, `45` = 4.5, `25` = 2.5)

## Anthropic models

| Model ID   | Use Case                                  | Cost | Speed  |
| :--------- | :---------------------------------------- | :--- | :----- |
| `fable51`  | Most capable, always-on adaptive thinking | $$$$ | Slow   |
| `opus5T`   | Top-tier reasoning, long-horizon work     | $$$$ | Slow   |
| `opus5`    | Most capable for agentic coding           | $$$$ | Slow   |
| `sonnet5T` | All-rounder with reasoning                | $$$  | Medium |
| `sonnet5`  | Strong all-rounder                        | $$$  | Medium |
| `haiku45T` | Fast with reasoning                       | $$   | Fast   |
| `haiku45`  | Fast responses                            | $$   | Fast   |

Fable 5.1, Opus 5, and Sonnet 5 (and the older Opus 4.6 to 4.8 and Sonnet 4.6) include the full 1M context window at standard pricing, with no opt-in or
beta header required. Haiku 4.5, Opus 4.5, and Sonnet 4.5 use a 200K context window.

Claude Fable 5.1 (`fable51`) is Anthropic's most capable model. Thinking is always on (adaptive, with summarized reasoning), so there is no separate `T` variant. It supports the full reasoning-effort range up to Extra High and the top Max tier, and is eligible for context compaction in tool-use mode.

Claude Opus 5 uses adaptive thinking only (extended thinking with a manual `budget_tokens` is no longer accepted). TeXRA's reasoning-effort selector maps to Anthropic's effort levels automatically: pick `opus5T` with Extra High (or the top Max tier) effort for the strongest agentic coding and long-horizon tasks. Opus 5 also supports high-resolution images for better figure, chart, and screenshot understanding. TeXRA downscales images above `texra.maxImageDimension` (default 2000px) before sending, so raise that setting to send higher-resolution figures.

## OpenAI models

| Model ID    | Use Case                       | Cost | Speed  |
| :---------- | :----------------------------- | :--- | :----- |
| `gpt56pro`  | Pro reasoning mode, 1M context | $$$$ | Slow   |
| `gpt56`     | Flagship reasoning, 1M context | $$$$ | Medium |
| `gpt56fast` | Flagship, fast variant         | $$$$ | Fast   |
| `gpt56-`    | Lower-cost reasoning           | $$$  | Fast   |
| `gpt56--`   | Budget reasoning               | $    | Fast   |

GPT-5.6 Sol (`gpt56`) is OpenAI's current flagship reasoning model; TeXRA pins the
[Codex integration](./agent-integrations.md#openai-codex) to `gpt-5.5`. GPT-5.6 Pro (`gpt56pro`)
runs the same model in the Responses API's pro reasoning mode, billed at standard token rates
rather than a premium tier, for the hardest planning and long-horizon tasks. It is hidden by
default; enable it from Settings → Providers & Models when you need it. For one-off hard questions you can
also enable the `inquiry` tool and paste the answer from your own ChatGPT subscription instead of
running a full agent turn against the API. `gpt56-` (Terra) and `gpt56--` (Luna) are the lower-cost
options for most workloads. Read the [OpenAI API reference](https://developers.openai.com/api/docs) for
full capabilities.

GPT-5 reasoning summaries require account verification. Enable them with `texra.model.gpt5ReasoningSummary`.

## Google models

| Model ID    | Use Case                       | Cost | Speed  |
| :---------- | :----------------------------- | :--- | :----- |
| `gemini31p` | Pro with reasoning, 1M context | $$$  | Medium |
| `gemini37f` | Flash model with 1M context    | $$   | Fast   |

## DeepSeek models

| Model ID         | Use Case                           | Cost | Speed  |
| :--------------- | :--------------------------------- | :--- | :----- |
| `deepseek`       | V4 Flash chat mode                 | $    | Fast   |
| `deepseekT`      | V4 Flash with reasoning            | $    | Medium |
| `deepseekvision` | V4 Flash Vision (Exp), image input | $    | Fast   |
| `deepseekpro`    | V4 Pro chat mode                   | $    | Medium |
| `deepseekproT`   | V4 Pro with reasoning              | $    | Medium |

## Moonshot Kimi models

| Model ID | Use Case                | Cost | Speed  |
| :------- | :---------------------- | :--- | :----- |
| `kimi3`  | K3 flagship, 1M context | $$$  | Medium |

## DashScope Qwen models

| Model ID    | Use Case                    | Cost | Speed  |
| :---------- | :-------------------------- | :--- | :----- |
| `qwenplus`  | Hybrid thinking, 1M context | $$   | Medium |
| `qwenturbo` | Fast with optional thinking | $    | Fast   |

## MiniMax models

| Model ID    | Use Case                                       | Cost | Speed  |
| :---------- | :--------------------------------------------- | :--- | :----- |
| `minimaxM3` | Flagship with interleaved thinking, 1M context | $    | Medium |

MiniMax uses interleaved thinking (chain-of-thought woven into responses). API keys are region-specific: international keys (api.minimax.io) and China keys (api.minimaxi.com) are not interchangeable. Expand the MiniMax row in **Providers & Models → API configuration** and toggle **MiniMax China region** (GLM, Kimi/Moonshot, and Qwen have matching toggles; GLM's is on by default).

- **International**: Get your API key at [platform.minimax.io](https://platform.minimax.io/)
- **China**: Get your API key at [platform.minimaxi.com](https://platform.minimaxi.com/)
- **Coding Plan**: MiniMax offers monthly subscription plans ($10/$20/$50/mo) as an alternative to pay-as-you-go. Coding Plan keys are **not interchangeable** with standard API keys; enter your Coding Plan key through **Set API key** as usual. [Subscribe to the MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan).

## GLM (Zhipu AI / Z.AI) models

| Model ID     | Use Case                                     | Cost | Speed  |
| :----------- | :------------------------------------------- | :--- | :----- |
| `glm53`      | Flagship, 1M context, reasoning-effort tiers | $$   | Medium |
| `glm52`      | Previous flagship (deprecated)               | $$   | Medium |
| `glm5turbo`  | Fast inference, agent-optimized              | $$$  | Medium |
| `glm5vturbo` | Multimodal vision model                      | $$   | Medium |

GLM models support thinking mode (reasoning is shown inline). The API uses a non-standard base path (`/api/paas/v4`), which TeXRA handles automatically.

- **International (Z.AI)**: Get your API key at [z.ai](https://z.ai/); endpoint: api.z.ai
- **China (BigModel)**: Get your API key at [open.bigmodel.cn](https://open.bigmodel.cn/); endpoint: open.bigmodel.cn (default)
- **Coding Plan**: GLM offers monthly subscription plans as an alternative to pay-as-you-go, with access to all GLM models. Coding Plan uses a separate endpoint (`/api/coding/paas/v4`). Turn on the **Coding Plan** toggle in the Providers & Models tab. [Subscribe to the GLM Coding Plan](https://z.ai/subscribe).

## Meta (Muse Spark) models

| Model ID      | Use Case                             | Cost | Speed  |
| :------------ | :----------------------------------- | :--- | :----- |
| `musespark11` | Reasoning + vision + PDF, 1M context | $$   | Medium |

Muse Spark always reasons (effort is adjustable but cannot be disabled). TeXRA
uses the Meta Model API's Responses surface, which carries reasoning across
turns and supports tool calling. The API is in public preview for US-based
developers.

- Get your API key at [dev.meta.ai](https://dev.meta.ai/) (Model API dashboard → API keys tab)

## Grok / xAI models

| Model ID | Use Case           | Cost | Speed  |
| :------- | :----------------- | :--- | :----- |
| `grok45` | Reasoning + vision | $$$  | Medium |

## Choosing a model

<ModelChoiceMatrix />

<p class="hero-caption">Pick a model by intent: each use case maps to a short list of recommended model ids.</p>

## Setting API keys

### Subscription-backed models in VS Code

The VS Code extension can also use compatible models from a GitHub Copilot
subscription. Open **Settings → Subscriptions → Copilot in VS Code**, then select
**Grant access**. VS Code shows its own consent prompt; TeXRA never asks for
or stores a Copilot API key.

Copilot models appear only in the VS Code extension because the official
Language Model API is an editor capability. They do not appear in the CLI or
desktop model lists. If Copilot quota is exhausted, the retry panel can start a
new run through the corresponding provider model once a usable provider API
key is available.

Using your own provider API key? TeXRA stores keys in VS Code's secret storage; they are never written to settings files.

1.  **Open the Settings Dashboard**: Select the <wa-icon library="texra" name="settings-gear"></wa-icon> gear icon at the top of the TeXRA panel, or run **TeXRA: Show Settings Dashboard** from the Command Palette.
2.  **Go to the Providers & Models tab**: The **API configuration** table lists every provider with its current key status (`Set`, `Env`, or `Not set`).
3.  **Set the key**: Find your provider's row and select the <wa-icon library="texra" name="key"></wa-icon> **Set API key** button, then paste your key. If you don't have a key yet, select the <wa-icon library="texra" name="arrow-up-right-from-square"></wa-icon> **Get** button to open the provider's API key page.

The Status column shows `Set` once the key is stored. To replace a key, set it again; to remove one, select the <wa-icon library="texra" name="trash"></wa-icon> trash icon. Repeat for each provider you plan to use.

<ApiKeysHero />

<p class="hero-caption">The Providers & Models tab's API configuration table: each provider shows its key status and Set / Get / Remove actions.</p>

::: tip Per-provider settings
Expand a provider's row (select the chevron) to toggle streaming or, for providers that support it, point requests at a custom endpoint.
:::

You can also place a `.env` file in your workspace with variables such as `OPENAI_API_KEY`. TeXRA loads it automatically, so you don't need to enter keys each time.

Already paying for a ChatGPT or Grok subscription? Sign in and skip the API key for those models.
Kimi Code and the GLM Coding Plan also run on a subscription you already pay for, authenticated with a
plan-specific key instead of a full provider key. Read
[Quick start → Add a key or connect a subscription](./quick-start.md#add-a-key-or-connect-a-subscription).

## Customizing the model list

Choose which models appear in the extension picker from the **Dashboard → Providers & Models** tab: toggle them on or off per provider, no JSON required (the choice is saved in the extension).

In the CLI TUI, run `/model` after a chat starts to see the models your current credentials can run. Mid-session switching is limited to models that share the active model's provider family; other entries are shown disabled with a reason, and switching waits until the current response finishes. To change family, start a new chat with `--model`. Startup also asks for a model when the launcher flow needs one after the agent or team choice.

For headless CLI runs, list what is available with `texra models list` (or `texra models show <id>` for details), then pick a default for your project by setting the `model` key in `.texra/config.json`, or override per run with `--model <id>`:

<CliModelsHero />

<p class="hero-caption">The id column is exactly what <code>--model</code> takes: the same short ids used in the tables above. <code>--all</code> includes models your current credentials can't run, with the reason.</p>

## Using OpenRouter

To access additional models or alternative pricing:

1. Get an [OpenRouter](https://openrouter.ai/) API key
2. Add it with the `TeXRA: Set API Key` command
3. In the Dashboard → Providers & Models tab → API configuration, expand the OpenRouter row and turn on **Use OpenRouter for all models**

Expanding any provider's row in **API Configuration** reveals its key field plus the per-provider toggles described here and under [Streaming](#streaming):

<ProviderConfigRow />

<p class="hero-caption">Expand a provider's <strong>API configuration</strong> row to reveal its masked key field, the per-provider <strong>Streaming</strong> switch (and <strong>Custom endpoint</strong> where supported); the OpenRouter row adds <strong>Use OpenRouter for all models</strong>.</p>

## Streaming

Streaming has a global default plus per-provider overrides. Open the **Dashboard → Providers & Models** tab: the **Enable streaming** toggle at the top of **API configuration** sets the default for all providers, and each expanded provider row has its own **Streaming** switch (shown in the [expanded provider row under Using OpenRouter](#using-openrouter)). When streaming is on, long responses
arrive incrementally instead of in one large reply.

## Next steps

- [Built-in agents](./built-in-agents.md): see which agents work with which models
- [Configuration](./configuration.md): model-related settings
