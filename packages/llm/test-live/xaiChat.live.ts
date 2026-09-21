// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'xai-chat',
  apiKeyEnv: 'XAI_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'xai-chat',
        requestedModel: 'grok-3-mini-beta',
        deployment: {
          endpoint: 'https://api.x.ai/v1',
          credentialScope: 'live',
        },
        supportsImageInput: true,
        supportedEfforts: ['low', 'high'],
        defaults: {
          temperature: 0,
          maxOutputTokens: 2048,
          parallelToolCalls: true,
          effort: null,
        },
      },
      { apiKey },
    ),
});
