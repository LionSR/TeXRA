// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'anthropic-messages',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  continuation: 'unsupported',
  model: 'anthropic/claude-haiku-5-5@none',
  endpoint: 'https://api.anthropic.com',
});
