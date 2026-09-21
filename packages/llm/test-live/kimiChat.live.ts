// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'kimi-chat',
  apiKeyEnv: 'MOONSHOT_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'kimi-chat',
        requestedModel: 'kimi-k2-turbo-preview',
        // The international platform; a moonshot.cn key does not work here.
        deployment: {
          endpoint: 'https://api.moonshot.ai/v1',
          credentialScope: 'live',
        },
        supportsImageInput: true,
        supportsInputTokenEstimation: false,
        thinkingControl: 'toggle',
        supportedEfforts: [],
        supportsForcedToolChoice: true,
        temperatureByThinking: { enabled: null, disabled: 0 },
        defaults: {
          maxOutputTokens: 2048,
          parallelToolCalls: true,
          thinking: { mode: 'disabled' },
          effort: null,
          preserveThinking: true,
        },
      },
      { apiKey },
    ),
});
