// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (MiniMax)',
  apiKeyEnv: 'MINIMAX_API_KEY',
  // Stateless: MiniMax documents no storage; its temperature range is (0, 1].
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'MiniMax-M3',
        deployment: {
          endpoint: 'https://api.minimax.io/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsStorage: false,
        supportsResponseChaining: false,
        supportsDocumentInput: false,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: ['high'],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: false,
        supportsForcedToolChoice: false,
        openaiEndpoint: false,
        requestDialect: 'compatible',
        defaults: {
          temperature: 1,
          maxOutputTokens: 2048,
          store: false,
          parallelToolCalls: true,
          reasoning: null,
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
