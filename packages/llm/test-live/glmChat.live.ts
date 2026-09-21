// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'glm-chat',
  apiKeyEnv: 'GLM_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'glm-chat',
        requestedModel: 'glm-4.5-air',
        // The international host; `open.bigmodel.cn` issues separate keys.
        deployment: {
          endpoint: 'https://api.z.ai/api/paas/v4',
          credentialScope: 'live',
        },
        supportsImageInput: false,
        supportsThinkingDisabled: true,
        supportedEfforts: [],
        defaults: {
          maxOutputTokens: 2048,
          temperature: 0,
          parallelToolCalls: true,
          thinking: { mode: 'disabled' },
          effort: null,
          clearThinking: true,
        },
      },
      { apiKey },
    ),
});
