# Supported AI providers

_Last Updated: August 18, 2026_

The table below lists the AI model providers TeXRA supports, their headquarters, and links to their terms and privacy policies. When you select a provider, your content is sent to that provider's API endpoints and is subject to their terms.

| Provider            | Headquarters           | Terms / Privacy                                                                                                                                                            |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic (Claude)  | San Francisco, CA, USA | [Terms](https://legal.anthropic.com/) · [Privacy](https://docs.anthropic.com/en/docs/legal-center/privacy) · [AUP](https://www.anthropic.com/legal/aup)                    |
| OpenAI (GPT)        | San Francisco, CA, USA | [Terms](https://openai.com/policies/row-terms-of-use/) · [Privacy](https://openai.com/policies/row-privacy-policy/) · [Usage](https://openai.com/policies/usage-policies/) |
| Google (Gemini)     | Mountain View, CA, USA | [Terms](https://ai.google.dev/gemini-api/terms) · [Privacy](https://policies.google.com/privacy)                                                                           |
| xAI (Grok)          | San Francisco, CA, USA | [Terms](https://x.ai/legal/terms-of-service) · [Privacy](https://x.ai/legal/privacy-policy)                                                                                |
| OpenRouter          | New York, NY, USA      | [Terms](https://openrouter.ai/terms) · [Privacy](https://openrouter.ai/privacy)                                                                                            |
| DeepSeek            | Hangzhou, China        | [Terms](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html) · [Privacy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)              |
| Moonshot AI (Kimi)  | Beijing, China         | [Terms](https://platform.moonshot.ai/docs/agreement/modeluse) · [Privacy](https://platform.moonshot.ai/docs/agreement/userprivacy)                                         |
| DashScope (Alibaba) | Hangzhou, China        | [Terms](https://www.alibabacloud.com/help/en/legal/) · [Privacy](https://www.alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-privacy-policy)     |
| MiniMax             | Beijing, China         | [Terms](https://www.minimax.io/platform/protocol/terms-of-service) · [Privacy](https://www.minimax.io/platform/protocol/privacy-policy)                                    |
| Zhipu AI (GLM)      | Beijing, China         | [Terms](https://docs.z.ai/legal-agreement/terms-of-use) · [Privacy](https://docs.z.ai/legal-agreement/privacy-policy)                                                      |
| Meta (Muse Spark)   | Menlo Park, CA, USA    | Model API terms presented at [dev.meta.ai](https://dev.meta.ai/) signup · [Privacy](https://www.facebook.com/privacy/policy/)                                              |

## Access modes

- **Personal API keys**: When you use your own API keys, requests go directly from your local TeXRA client (VS Code extension, CLI, or desktop app) to the provider. No data passes through TeXRA servers.
- **Provider subscriptions**: When you connect a provider subscription (ChatGPT or Grok via OAuth sign-in, or a Kimi Code / GLM Coding Plan via its plan-specific key), requests still go directly from your local TeXRA client to that provider's endpoints. No data passes through TeXRA servers.
- **GitHub Copilot in VS Code**: In the VS Code extension, models can also be served through a GitHub Copilot subscription via VS Code's language-model API. Those requests go from VS Code to GitHub/Microsoft's Copilot endpoints and are subject to GitHub's [terms of service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) and [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). No data passes through TeXRA servers.

## Your responsibility

You are responsible for selecting providers that comply with the data protection laws applicable to you (e.g., GDPR, UK GDPR, CCPA). Some providers operate in jurisdictions with different data protection standards. Review each provider's policies before use.

See also: [Terms of service](/terms)
