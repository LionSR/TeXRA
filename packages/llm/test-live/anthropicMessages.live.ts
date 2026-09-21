// Local imports
import { anthropicMessagesModel } from '../src/anthropicMessages.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'anthropic-messages',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    anthropicMessagesModel(
      {
        protocol: 'anthropic-messages',
        requestedModel: 'claude-haiku-4-5-20251001',
        deployment: {
          endpoint: 'https://api.anthropic.com',
          credentialScope: 'live',
        },
        supportsInputTokenEstimation: true,
        supportsTemperature: true,
        supportsForcedToolChoice: true,
        defaults: {
          maxOutputTokens: 2048,
          temperature: 0,
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
