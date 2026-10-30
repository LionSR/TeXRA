// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (DeepSeek)',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  // Stateless: DeepSeek ignores storage, so every turn resends the prefix.
  continuation: 'unsupported',
  model: 'deepseek/deepseek-flash@none',
  endpoint: 'https://api.deepseek.com',
});
