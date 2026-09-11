/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential: one well-known probe model per provider,
 * kept with model metadata so hosts do not each define their own setup routing
 * truth. Literal data — `SetupModelDefaults.vitest.ts` fails an llm-zoo bump
 * that retires or deprecates a pin, so a stale pin is fixed here rather than
 * silently swapped at runtime. The openai pin must stay Codex-eligible: it
 * proves ChatGPT-subscription access.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'opus5T',
  openai: 'gpt56',
  google: 'gemini31p',
  deepseek: 'deepseekproT',
  openRouter: 'sonnet5T',
  xai: 'grok45',
  moonshot: 'kimi26T',
  kimiCode: 'kimiCoding',
  dashscope: 'qwenplus',
  minimax: 'minimaxM3',
  glm: 'glm53',
  meta: 'musespark13',
};

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;

/** xAI-eligible setup model used to prove Grok subscription access. */
export const XAI_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.xai;
