// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (DashScope)',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  // DashScope stores responses by default and chains on their ids.
  continuation: 'supported',
  model: 'dashscope/qwen3-max',
  endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
});
