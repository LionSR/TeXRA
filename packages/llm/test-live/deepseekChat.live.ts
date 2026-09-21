// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'deepseek-chat',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'deepseek-chat',
        requestedModel: 'deepseek-chat',
        deployment: {
          endpoint: 'https://api.deepseek.com/v1',
          credentialScope: 'live',
        },
        supportedEfforts: [],
        supportsForcedToolChoice: true,
        defaults: {
          maxOutputTokens: 2048,
          temperature: 0,
          parallelToolCalls: true,
          thinking: { mode: 'disabled' },
          effort: null,
        },
      },
      { apiKey },
    ),
});
