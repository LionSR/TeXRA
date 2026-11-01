// Local imports
import { liveProtocol } from './support.js';

// A Kimi Code membership key: its own endpoint and quota, Kimi's wire.
liveProtocol({
  protocol: 'openai-responses (Kimi Code)',
  apiKeyEnv: 'KIMI_CODE_API_KEY',
  // Stateless: Kimi takes no `store`, and fixes its own sampling.
  continuation: 'unsupported',
  model: 'moonshot/kimi-for-coding@low',
  endpoint: 'https://api.kimi.com/coding/v1',
});
