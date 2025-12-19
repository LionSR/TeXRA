# Relay Tier Configuration Endpoint

This document describes the `/relay/tier-config` endpoint used to configure which models are available for each subscription tier.

## Overview

The tier configuration system allows Max tier users to access a subset of cheaper models via server-side API keys, without requiring their own keys. This configuration is fetched remotely from the relay server, enabling updates without extension releases.

## Tier Hierarchy

| Tier | Model Access | API Keys Required |
|------|--------------|-------------------|
| **Ultra** | All models | No (included) |
| **Max** | Subset of cheaper models | No (included) |
| **free** | None via relay | Yes (user's own) |

## Endpoint

```
GET https://remote.texra.ai/functions/v1/relay/tier-config
```

## Response Format

```json
{
  "tiers": {
    "Max": {
      "models": ["gemini2flash", "gemini2flashLite", "deepseekV3", "deepseekChat"],
      "providers": ["google", "deepseek"]
    },
    "Ultra": {
      "models": "*",
      "providers": ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope"]
    }
  }
}
```

## Schema

```typescript
interface TierAccessConfig {
  /** Model access: "*" for all models, or array of specific model names */
  models: "*" | string[];
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

Model names must match the short names defined in `src/model/ModelRegistry.ts`. Examples:

| Model Name | Full Name | Provider | Pricing (in/out per 1M) |
|------------|-----------|----------|-------------------------|
| `gemini2flash` | gemini-2.0-flash | Google | $0.10/$0.40 |
| `gemini2flashLite` | gemini-2.0-flash-lite | Google | $0.02/$0.08 |
| `deepseekV3` | deepseek-chat | Deepseek | $0.14/$0.28 |
| `deepseekReasoner` | deepseek-reasoner | Deepseek | $0.55/$2.19 |

## Implementation Details

### Client-Side Caching

- Configuration is cached for 5 minutes
- Cache is cleared on sign-in/sign-out
- Synchronous access available via `getTierConfigSync()` after initial fetch

### Fallback Behavior

If the endpoint returns an error or is unavailable:
1. Max tier users get no server-side access (fallback to own keys)
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
      ┌─────┴─────┐
      │           │
   Ultra       Max
      │           │
      ▼           ▼
  All models   Check allowedModels[]
```

## Example Supabase Edge Function

```typescript
// supabase/functions/relay/tier-config/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TIER_CONFIG = {
  tiers: {
    Max: {
      // Cheaper models for Max tier
      models: [
        "gemini2flash",
        "gemini2flashLite",
        "deepseekV3",
        "deepseekChat",
      ],
      providers: ["google", "deepseek"]
    },
    Ultra: {
      // All models for Ultra tier
      models: "*",
      providers: ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope"]
    }
  }
}

serve(async (req) => {
  // CORS headers
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    })
  }

  return new Response(JSON.stringify(TIER_CONFIG), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    }
  })
})
```

## Updating the Configuration

To update which models are available for Max tier:

1. Edit the edge function configuration
2. Deploy to Supabase
3. Changes take effect immediately (after 5-minute cache expiry)

No extension update required.

## Related Files

- `src/auth/tierModelAccess.ts` - Tier configuration fetching and caching
- `src/auth/serverSideKeyAccess.ts` - Server-side key access logic
- `src/model/computeModelOptions.ts` - Model availability computation
- `src/profileView/` - UI for displaying tier access info
