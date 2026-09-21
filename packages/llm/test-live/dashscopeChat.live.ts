// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'dashscope-chat',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'dashscope-chat',
        requestedModel: 'qwen-turbo-latest',
        // The international compatible-mode host; Bailian keys are separate.
        deployment: {
          endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          credentialScope: 'live',
        },
        defaults: {
          temperature: 0,
          maxOutputTokens: 2048,
          parallelToolCalls: true,
          stopSequences: [],
          thinking: { mode: 'disabled' },
        },
      },
      { apiKey },
    ),
});
