// Local imports
import { openaiChatModel } from '../src/openaiChat.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'minimax-chat',
  apiKeyEnv: 'MINIMAX_API_KEY',
  continuation: 'unsupported',
  bind: (apiKey) =>
    openaiChatModel(
      {
        protocol: 'minimax-chat',
        requestedModel: 'MiniMax-M2',
        // The international host; `api.minimaxi.com` is the China one.
        deployment: {
          endpoint: 'https://api.minimax.io/v1',
          credentialScope: 'live',
        },
        reasoningSplit: true,
        defaults: {
          // MiniMax rejects a zero temperature outright.
          temperature: 0.1,
          maxOutputTokens: 2048,
          parallelToolCalls: true,
          stopSequences: [],
        },
      },
      { apiKey },
    ),
});
