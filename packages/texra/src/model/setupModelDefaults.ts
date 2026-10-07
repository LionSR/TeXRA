/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential: one well-known probe model per provider,
 * so hosts do not each define their own setup routing truth. The pins are
 * literal data: `SetupModelDefaults.vitest.ts` fails an llm-zoo bump that
 * retires or deprecates one. The openai pin must stay Codex-eligible: it
 * proves ChatGPT-subscription access.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> =
  Object.freeze({
    openai: 'openai/gpt-6.1-sol',
    anthropic: 'anthropic/claude-opus-5-5',
    google: 'google/gemini-3.1-pro-preview',
    xai: 'xai/grok-4.7',
    deepseek: 'deepseek/deepseek-v4-pro',
    moonshot: 'moonshot/kimi-k3',
    dashscope: 'dashscope/qwen-plus',
    minimax: 'minimax/MiniMax-M3',
    glm: 'glm/glm-5.3',
    meta: 'meta/muse-spark-1.3',
    openRouter: 'anthropic/claude-sonnet-5-5',
    kimiCode: 'moonshot/kimi-k3',
  });

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;
