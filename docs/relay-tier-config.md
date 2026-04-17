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

- **Server-side keys**: No API key needed, subject to fair use policy
- **Personal API keys**: Full control, no restrictions

Toggle this option in the Profile view settings.

## Tier Hierarchy (Cumulative Access)

| Tier      | Model Access                    | Pricing Threshold | Additional Providers |
| --------- | ------------------------------- | ----------------- | -------------------- |
| **Ultra** | All models (premium included)   | $3+/M input       | + DashScope          |
| **Max**   | Mid-tier + all free tier models | $1-3/M input      | —                    |
| **free**  | Budget models only              | <$1/M input       | —                    |

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
        "haiku3",
        "haiku35",
        "gpt5-",
        "gpt5--",
        "gpt41-",
        "gpt41--",
        "gpt4o-",
        "gemini3f",
        "gemini25f",
        "gemini25f-",
        "deepseek",
        "deepseekT",
        "grok3-",
        "kimi128k",
        "kimi128kv",
        "kimit",
        "kimi2",
        "kimi2T"
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
        "haiku3",
        "haiku35",
        "gpt5-",
        "gpt5--",
        "gpt41-",
        "gpt41--",
        "gpt4o-",
        "gemini3f",
        "gemini25f",
        "gemini25f-",
        "deepseek",
        "deepseekT",
        "grok3-",
        "kimi128k",
        "kimi128kv",
        "kimit",
        "kimi2",
        "kimi2T",
        "haiku45",
        "haiku45T",
        "sonnet45T",
        "gemini3p",
        "gemini25p",
        "grok2",
        "grok2v",
        "kimi2+",
        "kimi2T+"
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

Model names must match the short names defined in `src/model/ModelRegistry.ts`.

### Free Tier Models (Under $1/M Input)

Available to all authenticated users.

| Model Name  | Full Name                         | Provider | Pricing (in/out per 1M) |
| ----------- | --------------------------------- | -------- | ----------------------- |
| `gpt5-`     | gpt-5-mini                        | OpenAI   | $0.25/$2.00             |
| `gpt5--`    | gpt-5-nano                        | OpenAI   | $0.05/$0.40             |
| `gpt41-`    | gpt-4.1-mini                      | OpenAI   | $0.40/$1.60             |
| `gpt41--`   | gpt-4.1-nano                      | OpenAI   | $0.10/$0.40             |
| `gpt4o-`    | gpt-4o-mini                       | OpenAI   | $0.15/$0.60             |
| `gemini3f`  | gemini-3-flash-preview            | Google   | $0.30/$2.50             |
| `deepseek`  | deepseek-chat (V3.2)              | Deepseek | $0.28/$0.42             |
| `deepseekT` | deepseek-reasoner (V3.2 Thinking) | Deepseek | $0.28/$0.42             |
| `grok3-`    | grok-3-mini-beta                  | xAI      | $0.30/$0.50             |
| `kimi128k`  | moonshot-v1-128k                  | Moonshot | $0.28/$1.12             |
| `kimi128kv` | moonshot-v1-128k-vision           | Moonshot | $0.35/$1.40             |
| `kimi2`     | kimi-k2-0905-preview              | Moonshot | $0.60/$2.50             |
| `kimi2T`    | kimi-k2-thinking                  | Moonshot | $0.56/$2.22             |

### Max Tier Additional Models ($1-3/M Input)

Available to Max tier subscribers (includes all free tier models).

| Model Name  | Full Name                    | Provider  | Pricing (in/out per 1M) |
| ----------- | ---------------------------- | --------- | ----------------------- |
| `haiku45`   | claude-haiku-4-5             | Anthropic | $1.00/$5.00             |
| `haiku45T`  | claude-haiku-4-5 (Thinking)  | Anthropic | $1.00/$5.00             |
| `sonnet45T` | claude-sonnet-4-5 (Thinking) | Anthropic | $3.00/$15.00            |
| `gemini3p`  | gemini-3-pro-preview         | Google    | $2.00/$12.00            |
| `gemini25p` | gemini-2.5-pro               | Google    | $1.25/$10.00            |
| `grok2`     | grok-2-1212                  | xAI       | $2.00/$10.00            |
| `grok2v`    | grok-2-1212-vision           | xAI       | $2.00/$10.00            |
| `kimi2+`    | kimi-k2-turbo-preview        | Moonshot  | $2.24/$8.88             |
| `kimi2T+`   | kimi-k2-thinking-turbo       | Moonshot  | $2.24/$8.88             |

### Ultra Tier Models ($3+/M Input)

Available to Ultra tier subscribers (includes all lower tier models).

| Model Name | Full Name                  | Provider  | Pricing (in/out per 1M) |
| ---------- | -------------------------- | --------- | ----------------------- |
| `opus47`   | claude-opus-4-7            | Anthropic | $5.00/$25.00            |
| `opus47T`  | claude-opus-4-7 (Thinking) | Anthropic | $5.00/$25.00            |
| `opus46`   | claude-opus-4-6            | Anthropic | $5.00/$25.00            |
| `opus46T`  | claude-opus-4-6 (Thinking) | Anthropic | $5.00/$25.00            |
| `opus45`   | claude-opus-4-5            | Anthropic | $15.00/$75.00           |
| `opus45T`  | claude-opus-4-5 (Thinking) | Anthropic | $15.00/$75.00           |
| `gpt5pro`  | gpt-5-pro                  | OpenAI    | $15.00/$120.00          |
| `gpt52pro` | gpt-5.2-pro                | OpenAI    | $21.00/$168.00          |
| `gpt5`     | gpt-5                      | OpenAI    | $1.25/$10.00            |
| `gpt51`    | gpt-5.1                    | OpenAI    | $1.25/$10.00            |
| `gpt52`    | gpt-5.2                    | OpenAI    | $1.75/$14.00            |
| `grok4`    | grok-4-0709                | xAI       | $3.00/$15.00            |

## Implementation Details

### Single Source of Truth

The relay function uses a `RELAY_MODELS` array as the single source of truth. Each model entry specifies:

- `shortName`: UI identifier
- `apiPatterns`: API name prefixes for server-side validation
- `minTier`: Minimum tier required ('free', 'Max', or 'Ultra')

Tier-specific arrays are derived automatically:

```typescript
const FREE_TIER_MODELS = RELAY_MODELS.filter((m) => m.minTier === 'free');
const MAX_TIER_MODELS = RELAY_MODELS.filter(
  (m) => m.minTier === 'free' || m.minTier === 'Max',
);
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
    All   Max    Free
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
