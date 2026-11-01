// Local imports
import { liveProtocol } from './support.js';

liveProtocol({
  protocol: 'openai-responses (MiniMax)',
  apiKeyEnv: 'MINIMAX_API_KEY',
  // Stateless: MiniMax documents no storage; its temperature range is (0, 1].
  continuation: 'unsupported',
  model: 'minimax/MiniMax-M3',
  endpoint: 'https://api.minimax.io/v1',
});
