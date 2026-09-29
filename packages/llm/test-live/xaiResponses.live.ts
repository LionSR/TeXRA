// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (xAI)',
  apiKeyEnv: 'XAI_API_KEY',
  // xAI stores responses and chains on their ids; a chained request carries
  // no instructions, since xAI refuses them beside `previous_response_id`.
  continuation: 'supported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'grok-4.3',
        deployment: {
          endpoint: 'https://api.x.ai/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: false,
        supportsTemperature: false,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsResponseChaining: true,
        supportsDocumentInput: false,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: ['low', 'high'],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: true,
        supportsForcedToolChoice: true,
        openaiEndpoint: false,
        requestDialect: 'openai',
        defaults: {
          temperature: null,
          maxOutputTokens: 2048,
          store: true,
          parallelToolCalls: true,
          reasoning: { effort: 'low', mode: null, summary: null },
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
