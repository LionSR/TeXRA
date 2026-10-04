/**
 * The models TeXRA starts with: the run default, the helper default and the
 * curated picker list. They are the app's choices over the llm catalog, not
 * catalog facts, and the stored agent config (`agentConfig.ts`)
 * prefault to them, so they live with the storage and not in
 * `@texra-ai/llm`.
 */

/**
 * Default model used for auxiliary/helper tasks (polishing, agent creation,
 * merge, session descriptions). DeepSeek V4.1 Flash is the cheapest capable
 * option (~$0.15/$0.60 per MTok) and keeps these one-shot, non-streaming
 * helper calls fast.
 */
export const DEFAULT_HELPER_MODEL = 'deepseek/deepseek-flash@none';

/**
 * Default model used when a new agent run / proposal omits one. Single source of
 * truth shared by the agent config schema (`@agent/core/definition/AgentConfig`),
 * the main-view persisted state, and the progress-view proposal reconstruction —
 * so a change here propagates to all three instead of drifting per call site.
 * `DEFAULT_MODELS` leads with this model, so it must not be a Gemini id.
 */
export const DEFAULT_AGENT_MODEL = 'openai/gpt-6.1-sol';

/**
 * Curated models every user starts with enabled; the persisted selection is a
 * delta over this list. `llm-zoo` has no "featured" flag to derive it from, so
 * it is literal data — `ModelOptionsBasic.vitest.ts` fails an llm-zoo bump that
 * retires or deprecates an entry, and the entry is replaced here.
 */
export const DEFAULT_MODELS: readonly string[] = [
  // The picker / new-chat default leads. Do not lead with Gemini — GPT is the
  // quality default.
  DEFAULT_AGENT_MODEL,
  'openai/gpt-5.6-terra',
  'openai/gpt-6-luna',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-5-5',
  'anthropic/claude-fable-5-1',
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
