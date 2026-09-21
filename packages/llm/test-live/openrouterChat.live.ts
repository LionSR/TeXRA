// Local imports
import { openrouterChatModel } from '../src/openrouterChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openrouter-chat',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openrouterChatModel(
      {
        protocol: 'openrouter-chat',
        requestedModel: 'anthropic/claude-haiku-4.5',
        deployment: {
          endpoint: 'https://openrouter.ai/api/v1',
          credentialScope: 'live',
        },
        supportsTemperature: true,
        supportsForcedToolChoice: true,
        supportsImageInput: true,
        supportsAudioInput: false,
        supportedEfforts: [],
        defaults: {
          maxOutputTokens: 2048,
          temperature: 0,
          effort: null,
          stopSequences: [],
        },
      },
      { apiKey },
    ),
});
