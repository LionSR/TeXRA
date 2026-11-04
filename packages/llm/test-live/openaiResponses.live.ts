// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses',
  apiKeyEnv: 'OPENAI_API_KEY',
  // Stored responses plus response chaining: the codec returns an anchor the
  // next turn sends in place of the prefix it covers.
  continuation: 'supported',
  model: 'openai/gpt-4.1-mini-2025-04-14',
  endpoint: 'https://api.openai.com/v1',
});
