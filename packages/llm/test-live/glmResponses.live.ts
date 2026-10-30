// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (GLM)',
  apiKeyEnv: 'GLM_API_KEY',
  // Zhipu stores responses for seven days and chains on their ids.
  continuation: 'supported',
  model: 'glm/glm-5.3@low',
  endpoint: 'https://open.bigmodel.cn/api/v1',
});
