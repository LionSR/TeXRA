// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-chat',
  apiKeyEnv: 'OPENAI_API_KEY',
  // The Chat codec rejects `turn.continuation` by contract: chaining belongs
  // to Responses, and this route leaves no anchor to chain on.
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'openai-chat',
        requestedModel: 'gpt-4.1-mini-2025-04-14',
        deployment: {
          endpoint: 'https://api.openai.com/v1',
          credentialScope: 'live',
        },
        supportsTemperature: true,
        supportedEfforts: [],
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
