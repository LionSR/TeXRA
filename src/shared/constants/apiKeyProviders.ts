/**
 * Provider IDs where users can configure direct API keys.
 *
 * This is the single source for direct key-provider enumeration. It is kept
 * separate from the provider display registry so model/core key lookup can
 * depend on a tiny data-only module.
 */
export const API_KEY_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'openRouter',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
  'meta',
] as const;
