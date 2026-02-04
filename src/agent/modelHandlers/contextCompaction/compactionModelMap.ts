/**
 * Default compaction model fallbacks for known model families.
 *
 * This map is used when no explicit override is configured via
 * `texra.model.compactionModelOverrides`.
 */
const COMPACTION_MODEL_MAP: Record<string, string> = {
  // Anthropic: opus → sonnet (both 4.5, sonnet is faster)
  'claude-opus-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',

  // OpenAI: keep same model unless a cheaper variant is known
  'gpt-5.2': 'gpt-5.2',
  'gpt-4.1': 'gpt-4.1-mini',
  'gpt-4.1-mini': 'gpt-4.1-mini',

  // Google: pro → flash
  'gemini-3-pro': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',

  // DeepSeek: same model (no cheaper option)
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',

  // Kimi: same model
  'kimi-k2': 'kimi-k2',
  'kimi-k1.5-long': 'kimi-k1.5-long',
};

export function getCompactionModel(primaryModel: string): string {
  return COMPACTION_MODEL_MAP[primaryModel] ?? primaryModel;
}
