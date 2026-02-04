/**
 * Compaction model mapping.
 *
 * Maps primary models to appropriate compaction models.
 * Generally uses a capable but faster/cheaper model from the same provider family.
 *
 * The compaction model is used for generating context summaries, which is a
 * straightforward task that doesn't require extended thinking.
 */

/**
 * Maps primary model names to their compaction model counterparts.
 * Uses capable but faster/cheaper models from the same family.
 */
export const COMPACTION_MODEL_MAP: Record<string, string> = {
  // Anthropic: opus → sonnet (both 4.5, sonnet is faster)
  'claude-opus-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',

  // OpenAI: use same model (summarization uses fewer thinking tokens)
  'gpt-5.2': 'gpt-5.2',
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1-mini',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  o1: 'gpt-4o',
  'o1-mini': 'gpt-4o-mini',
  o3: 'gpt-4o',
  'o3-mini': 'gpt-4o-mini',
  'o4-mini': 'gpt-4o-mini',

  // Google: pro → flash
  'gemini-3-pro': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite',
  'gemini-1.5-pro': 'gemini-1.5-flash',
  'gemini-1.5-flash': 'gemini-1.5-flash',

  // DeepSeek: same model (no cheaper option)
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',

  // Kimi: same model
  'kimi-k2': 'kimi-k2',
  'kimi-k1.5-long': 'kimi-k1.5-long',
  'moonshot-v1-128k': 'moonshot-v1-8k',
  'moonshot-v1-32k': 'moonshot-v1-8k',
  'moonshot-v1-8k': 'moonshot-v1-8k',

  // xAI
  'grok-3': 'grok-3-mini',
  'grok-3-mini': 'grok-3-mini',
  'grok-2': 'grok-2',

  // DashScope (Qwen)
  'qwen-max': 'qwen-plus',
  'qwen-plus': 'qwen-plus',
  'qwen-turbo': 'qwen-turbo',
};

/**
 * Gets the appropriate compaction model for a given primary model.
 * Falls back to the same model if no mapping exists.
 *
 * @param primaryModel - The primary model name
 * @returns The compaction model name to use
 */
export function getCompactionModel(primaryModel: string): string {
  return COMPACTION_MODEL_MAP[primaryModel] ?? primaryModel;
}
