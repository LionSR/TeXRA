// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (xAI)',
  apiKeyEnv: 'XAI_API_KEY',
  // xAI stores responses and chains on their ids; a chained request carries
  // no instructions, since xAI refuses them beside `previous_response_id`.
  continuation: 'supported',
  model: 'xai/grok-4.3@low',
  endpoint: 'https://api.x.ai/v1',
});
