# Relay Edge Function Setup

This guide explains how to deploy and configure the Relay Edge Function for server-side API keys.

## Overview

The Relay function allows authenticated users to access AI models without providing their own API keys. Access is tier-based:

- **Ultra**: All models including premium ($3+/M input)
- **Max**: Mid-tier models ($1-3/M) + all free tier models
- **free**: Budget models only (under $1/M input)

The API keys are stored as Supabase secrets and the relay forwards requests to the appropriate provider.

## Supported Providers

- OpenAI
- Anthropic
- Google (Gemini)
- xAI (Grok)
- DeepSeek
- Moonshot (Kimi)
- DashScope (Qwen)

## Deployment Steps

### 1. Deploy the Edge Function

```bash
cd /path/to/TeXRA
supabase login
supabase link --project-ref your-project-id
supabase functions deploy relay --no-verify-jwt
```

### 2. Set API Key Secrets

Store your API keys as Supabase secrets:

```bash
# Required secrets (set only the ones you want to support)
supabase secrets set OPENAI_API_KEY="sk-..."
supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
supabase secrets set GOOGLE_API_KEY="AIza..."
supabase secrets set XAI_API_KEY="xai-..."
supabase secrets set DEEPSEEK_API_KEY="sk-..."
supabase secrets set MOONSHOT_API_KEY="sk-..."
supabase secrets set DASHSCOPE_API_KEY="sk-..."
```

### 3. Verify Deployment

The function will be available at:

```
https://your-project.supabase.co/functions/v1/relay/{provider}/{...path}
```

Example for OpenAI:

```
https://your-project.supabase.co/functions/v1/relay/openai/v1/chat/completions
```

## How It Works

1. **User makes request** - Client sends request with user's JWT in Authorization header
2. **Relay validates user** - Checks JWT and verifies user has Ultra tier
3. **Relay adds API key** - Retrieves server-side API key from secrets
4. **Request forwarded** - Request is forwarded to the actual provider
5. **Response streamed back** - Response is streamed back to the client

## URL Structure

```
/relay/{provider}/{...apiPath}
```

Examples:

- `/relay/openai/v1/chat/completions`
- `/relay/anthropic/v1/messages`
- `/relay/google/v1beta/models/gemini-pro:generateContent`

## Security

- **Authentication**: All requests must include a valid Supabase JWT
- **Authorization**: Model access is tier-based (see Overview above)
- **API Keys**: Stored as Supabase secrets (never exposed to clients)
- **CORS**: Configured for web access

## Client-Side Settings

All authenticated users can toggle between "Included Access" and "Use My Own Keys" in the Profile view. By default, included access is enabled.

When using included access:

1. Models from supported providers will show as available (no API key warning)
2. Requests will be routed through the relay
3. User's JWT will be used for authentication

## Testing

You can test the relay function directly:

```bash
curl -X POST \
  'https://your-project.supabase.co/functions/v1/relay/openai/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_SUPABASE_JWT' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Error Responses

| Status | Error                  | Description                              |
| ------ | ---------------------- | ---------------------------------------- |
| 400    | Invalid path           | URL doesn't match expected format        |
| 400    | Unsupported provider   | Provider not in supported list           |
| 401    | Missing authorization  | No Authorization header                  |
| 401    | Invalid token          | JWT is invalid or expired                |
| 403    | Profile not found      | User has no profile record               |
| 403    | Provider not available | Provider not enabled for user's tier     |
| 403    | Model not available    | Model not in user's tier allowed list    |
| 503    | API key not configured | Server doesn't have API key for provider |

## Deployment

To update the relay function after changes:

```bash
supabase functions deploy relay
```

Changes take effect immediately. Client caches expire after 5 minutes.

## Future Enhancements

- [ ] Rate limiting per user
- [ ] Usage tracking and quotas
- [ ] Cost tracking per user
