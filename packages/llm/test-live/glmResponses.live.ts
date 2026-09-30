// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (GLM)',
  apiKeyEnv: 'GLM_API_KEY',
  // Zhipu stores responses for seven days and chains on their ids.
  continuation: 'supported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'glm-5.3',
        deployment: {
          endpoint: 'https://open.bigmodel.cn/api/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsDocumentInput: false,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: [
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: false,
        supportsForcedToolChoice: false,
        openaiEndpoint: false,
        requestDialect: 'compatible',
        defaults: {
          temperature: 0,
          maxOutputTokens: 2048,
          store: true,
          parallelToolCalls: true,
          reasoning: { effort: 'none', mode: null, summary: null },
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
