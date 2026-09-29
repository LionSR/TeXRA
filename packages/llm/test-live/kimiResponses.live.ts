// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (Kimi)',
  apiKeyEnv: 'MOONSHOT_API_KEY',
  // Stateless: Kimi takes no `store`, and fixes its own sampling.
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'kimi-k3',
        deployment: {
          endpoint: 'https://api.moonshot.ai/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: false,
        supportsTemperature: false,
        supportsMaxOutputTokens: true,
        supportsStorage: false,
        supportsResponseChaining: false,
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
