// Local imports
import { liveProtocol } from './support.js';

// A Coding Plan key on the endpoint API keys use; Zhipu serves Responses
// to both from open.bigmodel.cn/api/v1, and this suite is that claim.
liveProtocol({
  protocol: 'openai-responses (GLM Coding Plan)',
  apiKeyEnv: 'GLM_CODING_PLAN_API_KEY',
  // Zhipu stores responses for seven days and chains on their ids.
  continuation: 'supported',
  model: 'glm/glm-5.3@low',
  endpoint: 'https://open.bigmodel.cn/api/v1',
  route: { glmCodingPlan: true },
});
