// Local imports
import { liveProtocol } from './support.js';

// Z.AI, Zhipu's international host, serves the same Responses API as
// BigModel; a BigModel key is accepted here too.
liveProtocol({
  protocol: 'openai-responses (GLM, Z.AI)',
  apiKeyEnv: 'ZAI_API_KEY',
  // Zhipu stores responses for seven days and chains on their ids.
  continuation: 'supported',
  model: 'glm/glm-5.3@low',
  endpoint: 'https://api.z.ai/api/v1',
});
