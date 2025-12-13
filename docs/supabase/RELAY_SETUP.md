# Relay Edge Function Setup

This guide explains how to deploy and configure the Relay Edge Function for server-side API keys.

## Overview

The Relay function allows **Ultra** tier users to access AI models without providing their own API keys. The API keys are stored as Supabase secrets and the relay forwards requests to the appropriate provider.

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
supabase functions deploy relay
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
- **Authorization**: Only users with `tier = 'Ultra'` can use the relay
- **API Keys**: Stored as Supabase secrets (never exposed to clients)
- **CORS**: Configured for web access

## Client-Side Settings

Users must enable the experimental setting in VS Code:

```json
{
  "texra.experimental.useServerSideKeys": true
}
```

When enabled:
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

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Invalid path | URL doesn't match expected format |
| 400 | Unsupported provider | Provider not in supported list |
| 401 | Missing authorization | No Authorization header |
| 401 | Invalid token | JWT is invalid or expired |
| 403 | Profile not found | User has no profile record |
| 403 | Ultra tier required | User is not Ultra tier |
| 503 | API key not configured | Server doesn't have API key for provider |

## Future Enhancements

- [ ] Rate limiting per user
- [ ] Usage tracking and quotas
- [ ] Model-level restrictions
- [ ] Cost tracking per user
