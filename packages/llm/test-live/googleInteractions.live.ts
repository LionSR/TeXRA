// Local imports
import { googleInteractionsModel } from '../src/googleInteractions.js';
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'google-interactions',
  apiKeyEnv: 'GOOGLE_API_KEY',
  // A stored interaction leaves an anchor over the steps it already holds;
  // the next turn sends only what follows them.
  continuation: 'supported',
  bind: (apiKey) =>
    googleInteractionsModel(
      {
        protocol: 'google-interactions',
        requestedModel: 'gemini-flash-latest',
        deployment: {
          endpoint: 'https://generativelanguage.googleapis.com',
          credentialScope: 'live',
        },
        background: 'unsupported',
        supportsInputTokenEstimation: true,
        defaults: {
          maxOutputTokens: 2048,
          store: true,
          thinkingLevel: 'low',
        },
      },
      { apiKey },
    ),
});
