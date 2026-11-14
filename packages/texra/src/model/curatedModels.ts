/**
 * TeXRA's model choices over the llm catalog: the launcher's default model
 * and the curated picker list, which TeXRA's settings catalog hands the
 * harness (`curatedModels`). They are not catalog facts, so they do not live
 * in `@texra-ai/llm`, and not the harness's, which curates none.
 */

/**
 * The model a new launch starts on when the launcher has stored none.
 * `CURATED_MODELS` leads with it, so it must not be a Gemini id.
 */
export const DEFAULT_AGENT_MODEL = 'openai/gpt-6.1-sol';

/**
 * Curated models every user starts with enabled; the persisted selection is a
 * delta over this list. `llm-zoo` has no "featured" flag to derive it from, so
 * it is literal data, replaced here when an llm-zoo bump retires or
 * deprecates an entry.
 */
// `PinnedModels.vitest.ts` fails such a bump.
export const CURATED_MODELS: readonly string[] = [
  // The picker / new-chat default leads. Do not lead with Gemini — GPT is the
  // quality default.
  DEFAULT_AGENT_MODEL,
  'openai/gpt-5.6-terra',
  'openai/gpt-6-luna',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-5-5',
  'anthropic/claude-fable-5-1',
  'google/gemini-4-argon',
  'google/gemini-3.8-flash',
  'google/gemini-3.1-pro-preview',

  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-pro',
  'moonshot/kimi-k3',
  // Current non-retired GLM flagships.
  'glm/glm-5.3',
  // Current non-retired xAI flagship — API key or experimental Grok OAuth.
  'xai/grok-4.7',
  'meta/muse-spark-1.3',
];
