/** Consolidated provider display names used across settings UI and model selection. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openRouter: 'OpenRouter',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  dashscope: 'DashScope',
  wolframllmapp: 'Wolfram',
  copilot: 'Copilot',
  others: 'Others',
};

/** Providers that have models in the model selection list (display order). */
export const MODEL_PROVIDERS_ORDER = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS_ORDER)[number];

/** Default model used for instruction polishing. */
export const DEFAULT_POLISH_MODEL = 'sonnet45';
