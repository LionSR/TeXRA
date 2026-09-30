// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

// A Kimi Code membership key: its own endpoint and quota, Kimi's wire.
liveProtocol({
  protocol: 'openai-responses (Kimi Code)',
  apiKeyEnv: 'KIMI_CODE_API_KEY',
  // Stateless: Kimi takes no `store`, and fixes its own sampling.
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'kimi-for-coding',
        deployment: {
          endpoint: 'https://api.kimi.com/coding/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsTemperature: false,
        supportsMaxOutputTokens: true,
        supportsStorage: false,
        supportsDocumentInput: false,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: ['low', 'high', 'max'],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: false,
        supportsForcedToolChoice: false,
        openaiEndpoint: false,
        requestDialect: 'compatible',
        defaults: {
          temperature: null,
          maxOutputTokens: 2048,
          store: false,
          parallelToolCalls: true,
          reasoning: { effort: 'low', mode: null, summary: null },
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
