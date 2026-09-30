// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (DashScope)',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  // DashScope stores responses by default and chains on their ids.
  continuation: 'supported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'qwen3-max',
        deployment: {
          endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsDocumentInput: false,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: [],
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
          reasoning: null,
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
