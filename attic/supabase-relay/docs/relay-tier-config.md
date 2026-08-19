# Relay Tier Configuration Endpoint

This document describes the `/relay/tier-config` endpoint used to configure which models are available for each subscription tier.

## Overview

The tier configuration system provides cumulative model access based on user subscription tier. All authenticated users can access models via server-side API keys, with access expanding at higher tiers.

## Researcher Access Program

All server-side API key access is provided as part of the **Researcher Access Program**. This is a convenience for researchers and academics who want to explore AI models without managing their own API keys.

### Fair Use Policy

- Personal research and academic use only
- No commercial use or production deployments
- No automated/bot access or bulk operations
- Excessive usage may result in account suspension

### User Choice

Users can ALWAYS choose between:

- **Server-side keys**: No API key needed, subject to fair use policy and tier limits
- **Personal API keys**: Full control, no tier restrictions — access any model including Opus, GPT-5, and other premium models

> **Tip:** To use premium models (Opus, GPT-5, etc.) on the free tier, add your own API key in the Profile view. The tier limits only apply to server-side keys.

Toggle this option in the Profile view settings.

## Tier Hierarchy (Cumulative Access)

| Tier      | Model Access                           | Pricing Threshold | Additional Providers |
| --------- | -------------------------------------- | ----------------- | -------------------- |
| **Ultra** | All models (premium included)          | >$3/M input       | + DashScope          |
| **Max**   | Same as free (≤$3/M)                   | ≤$3/M input       | —                    |
| **free**  | All non-premium models (no Opus/GPT-5) | ≤$3/M input       | —                    |

All tiers have access to: OpenAI, Anthropic, Google, DeepSeek, xAI, Moonshot

## Endpoint

```
GET https://remote.texra.ai/functions/v1/relay/tier-config
```

## Response Format

```json
{
  "tiers": {
    "free": {
      "models": [
        "gpt54-",
        "gpt54--",
        "deepseek",
        "deepseekT",
        "glm5",
        "minimaxM27",
        "minimaxM25",
        "kimi26",
        "kimi26T",
        "qwenplus",
        "qwenturbo",
        "haiku45",
        "haiku45T",
        "sonnet46",
        "sonnet46T",
        "gemini31p",
        "gemini35f",
        "grok4",
        "deepseekpro",
        "deepseekproT",
        "glm51",
        "glm5vturbo",
        "glm5turbo"
      ],
      "providers": [
        "openai",
        "anthropic",
        "google",
        "deepseek",
        "xai",
        "moonshot"
      ]
    },
    "Max": {
      "models": [
        "gpt54-",
        "gpt54--",
        "deepseek",
        "deepseekT",
        "glm5",
        "minimaxM27",
        "minimaxM25",
        "kimi26",
        "kimi26T",
        "qwenplus",
        "qwenturbo",
        "haiku45",
        "haiku45T",
        "sonnet46",
        "sonnet46T",
        "gemini31p",
        "gemini35f",
        "grok4",
        "deepseekpro",
        "deepseekproT",
        "glm51",
        "glm5vturbo",
        "glm5turbo"
      ],
      "providers": [
        "openai",
        "anthropic",
        "google",
        "deepseek",
        "xai",
        "moonshot"
      ]
    },
    "Ultra": {
      "models": "*",
      "providers": [
        "openai",
        "anthropic",
        "google",
        "xai",
        "deepseek",
        "moonshot",
        "dashscope"
      ]
    }
  }
}
```

## Schema

```typescript
interface TierAccessConfig {
  /** Model access: "*" for all models, or array of specific model names */
  models: '*' | string[];
  /** Providers enabled for this tier */
  providers: string[];
}

interface TierModelConfig {
  tiers: {
    free?: TierAccessConfig;
    Max?: TierAccessConfig;
    Ultra?: TierAccessConfig;
  };
}
```

## Model Names

Model names must match the short names defined by the [`llm-zoo`](https://www.npmjs.com/package/llm-zoo) package's `MODEL_CONFIGS` — the same source of truth `src/model/modelOptionsBasic.ts` and the relay function (`supabase/functions/relay/models.ts`) both import.

::: warning Auto-derived snapshot
The model rows and prices below are a **snapshot of `llm-zoo` `MODEL_CONFIGS`**. The relay builds its model list and tier assignments automatically from that package (see [Single Source of Truth](#single-source-of-truth)), so individual IDs and prices here drift whenever `llm-zoo` is bumped. Treat the tables as illustrative and re-derive from `MODEL_CONFIGS` before relying on a specific value.

**Prices last verified against `llm-zoo@1.8.1` `MODEL_CONFIGS`: 2026-06-08.**
:::

### Free / Max Tier Models (≤$3/M Input)

Available to all authenticated users (free and Max tiers have the same access).

| Model Name     | Full Name                            | Provider  | Pricing (in/out per 1M) |
| -------------- | ------------------------------------ | --------- | ----------------------- |
| `gpt54-`       | gpt-5.4-mini-2026-03-17              | OpenAI    | $0.75/$4.50             |
| `gpt54--`      | gpt-5.4-nano-2026-03-17              | OpenAI    | $0.20/$1.25             |
| `deepseek`     | deepseek-v4-flash                    | DeepSeek  | $0.14/$0.28             |
| `deepseekT`    | deepseek-v4-flash (Thinking)         | DeepSeek  | $0.14/$0.28             |
| `glm5`         | glm-5                                | GLM       | $0.80/$2.56             |
| `minimaxM27`   | MiniMax-M2.7                         | MiniMax   | $0.30/$1.20             |
| `minimaxM25`   | MiniMax-M2.5                         | MiniMax   | $0.20/$1.20             |
| `kimi26`       | kimi-k2.6                            | Moonshot  | $0.60/$2.80             |
| `kimi26T`      | kimi-k2.6 (Thinking)                 | Moonshot  | $0.60/$2.80             |
| `qwenplus`     | qwen-plus                            | DashScope | $0.40/$1.20             |
| `qwenturbo`    | qwen-turbo-latest                    | DashScope | $0.05/$0.50             |
| `haiku45`      | claude-haiku-4-5-20251001            | Anthropic | $1.00/$5.00             |
| `haiku45T`     | claude-haiku-4-5-20251001 (Thinking) | Anthropic | $1.00/$5.00             |
| `sonnet46`     | claude-sonnet-4-6                    | Anthropic | $3.00/$15.00            |
| `sonnet46T`    | claude-sonnet-4-6 (Thinking)         | Anthropic | $3.00/$15.00            |
| `gemini31p`    | gemini-3.1-pro-preview               | Google    | $2.00/$12.00            |
| `gemini35f`    | gemini-3.5-flash                     | Google    | $1.50/$9.00             |
| `grok4`        | grok-4-0709                          | xAI       | $3.00/$15.00            |
| `deepseekpro`  | deepseek-v4-pro                      | DeepSeek  | $0.44/$0.87             |
| `deepseekproT` | deepseek-v4-pro (Thinking)           | DeepSeek  | $0.44/$0.87             |
| `glm51`        | glm-5.1                              | GLM       | $1.05/$3.50             |
| `glm5vturbo`   | glm-5v-turbo                         | GLM       | $1.20/$4.00             |
| `glm5turbo`    | glm-5-turbo                          | GLM       | $1.20/$4.00             |

### Ultra Tier Models (>$3/M Input)

Available to Ultra tier subscribers only (includes all lower tier models).

| Model Name | Full Name                | Provider  | Pricing (in/out per 1M) |
| ---------- | ------------------------ | --------- | ----------------------- |
| `opus5`    | claude-opus-5            | Anthropic | $5.00/$25.00            |
| `opus5T`   | claude-opus-5 (Thinking) | Anthropic | $5.00/$25.00            |
| `gpt55`    | gpt-5.5-2026-04-23       | OpenAI    | $5.00/$30.00            |
| `gpt55pro` | gpt-5.5-pro-2026-04-23   | OpenAI    | $30.00/$180.00          |

## Implementation Details

### Single Source of Truth

The relay function builds its `RELAY_MODELS` array automatically from the `llm-zoo` package's `MODEL_CONFIGS` (every non-`openRouterOnly` model), so no model list is hand-maintained. Each derived entry specifies:

- `shortName`: UI identifier (from `config.name`)
- `apiPatterns`: API name prefixes for server-side validation (from `config.fullName`)
- `inputPrice`: input price per 1M tokens (from `config.inputPrice`)
- `minTier`: minimum tier required, computed from `inputPrice` — `≤$3` → `free`, `>$3` → `Ultra`. (Free and Max share the same ≤$3 cutoff, so all non-Ultra models are assigned `free`.)

Tier-specific arrays are derived automatically:

```typescript
const FREE_TIER_MODELS = RELAY_MODELS.filter((m) => m.minTier === 'free');
const MAX_TIER_MODELS = RELAY_MODELS.filter(
  (m) => m.minTier === 'free' || m.minTier === 'Max',
);
// Currently identical since all non-Ultra models are assigned 'free'
```

### Client-Side Caching

- Configuration is cached for 5 minutes
- Cache is cleared on sign-in/sign-out
- Synchronous access available via `getTierConfigSync()` after initial fetch

### Fallback Behavior

If the endpoint returns an error or is unavailable:

1. Free/Max tier users get no server-side access (fallback to own keys)
2. Ultra tier users fall back to the `/relay/providers` enabled list

### Access Check Flow

```
User selects model
       │
       ▼
┌─────────────────────────┐
│ canUseServerSideKeys()  │ ◄── Checks tier + setting + providers
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────────────┐
│ canUseServerSideKeysForModel()  │ ◄── Checks model in tier's allowed list
└───────────┬─────────────────────┘
            │
      ┌─────┼─────┐
      │     │     │
   Ultra   Max   free
      │     │     │
      ▼     ▼     ▼
    All   Free   Free
  models models models
```

## Updating the Configuration

To update which models are available:

1. Edit `RELAY_MODELS` in `supabase/functions/relay/index.ts`
2. Deploy to Supabase
3. Changes take effect immediately (after 5-minute cache expiry)

No extension update required.

## Related Files

- `supabase/functions/relay/index.ts` - Single source of truth for tier models
- `src/auth/tier/TierService.ts` - Tier configuration fetching and caching
- `src/auth/serverKeys/ServerSideKeyService.ts` - Server-side key access logic
- `src/model/computeModelOptions.ts` - Model availability computation
- `src/profileView/` - UI for displaying tier access info
