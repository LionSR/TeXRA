/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential. Kept with model metadata so hosts do not
 * each define their own setup routing truth.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'opus48T',
  openai: 'gpt55',
  google: 'gemini31p',
  deepseek: 'deepseekproT',
  openRouter: 'sonnet46T',
  xai: 'grok4',
  moonshot: 'kimi25T',
  dashscope: 'qwen3max',
  minimax: 'minimax01',
  glm: 'glm5',
};

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;
