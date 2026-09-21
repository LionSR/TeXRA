// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses',
  apiKeyEnv: 'OPENAI_API_KEY',
  // Stored responses plus response chaining: the codec returns an anchor the
  // next turn sends in place of the prefix it covers.
  continuation: 'supported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'gpt-4.1-mini-2025-04-14',
        deployment: {
          endpoint: 'https://api.openai.com/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsResponseChaining: true,
        supportsDocumentInput: true,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: [],
        instructions: { kind: 'optional' },
        defaults: {
          temperature: 0,
          maxOutputTokens: 2048,
          store: true,
          parallelToolCalls: true,
          reasoning: null,
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
