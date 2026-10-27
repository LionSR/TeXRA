// Local imports
import { anthropicMessagesModel } from '../src/api/anthropicMessages.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'anthropic-messages',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    anthropicMessagesModel(
      {
        protocol: 'anthropic-messages',
        requestedModel: 'claude-haiku-5-5',
        deployment: {
          endpoint: 'https://api.anthropic.com',
          credentialScope: 'live',
        },
        supportsSystemMessages: false,
        defaults: {
          maxOutputTokens: 2048,
          parallelToolCalls: true,
          thinking: { mode: 'disabled' },
          effort: null,
          cache: 'disabled',
          stopSequences: [],
        },
      },
      { apiKey },
    ),
});
