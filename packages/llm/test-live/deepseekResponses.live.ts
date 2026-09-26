// Local imports
import { openaiResponsesModel } from '../src/openaiResponses.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (DeepSeek)',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  // Stateless: DeepSeek ignores storage, so every turn resends the prefix.
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiResponsesModel(
      {
        protocol: 'openai-responses',
        requestedModel: 'deepseek-flash',
        deployment: {
          endpoint: 'https://api.deepseek.com',
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
        allowedReasoningEfforts: ['none', 'low', 'high', 'max'],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: false,
        supportsForcedToolChoice: true,
        requestDialect: 'compatible',
        defaults: {
          temperature: 0,
          maxOutputTokens: 2048,
          store: false,
          parallelToolCalls: true,
          reasoning: { effort: 'none', mode: null, summary: null },
          serviceTier: null,
        },
      },
      { authentication: { kind: 'api-key', apiKey } },
    ),
});
