// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'google-interactions',
  apiKeyEnv: 'GOOGLE_API_KEY',
  // A stored interaction leaves an anchor over the steps it already holds;
  // the next turn sends only what follows them.
  continuation: 'supported',
  model: 'google/gemini-flash-latest@low',
  endpoint: 'https://generativelanguage.googleapis.com',
});
