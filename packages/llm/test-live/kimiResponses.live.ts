// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (Kimi)',
  apiKeyEnv: 'MOONSHOT_API_KEY',
  // Stateless: Kimi takes no `store`, and fixes its own sampling.
  continuation: 'unsupported',
  model: 'moonshot/kimi-k3@low',
  endpoint: 'https://api.moonshot.ai/v1',
});
