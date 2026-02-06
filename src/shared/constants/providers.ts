import { ModelProvider } from 'llm-zoo';

/** Consolidated provider display names used across settings UI and model selection. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  [ModelProvider.OPENAI]: 'OpenAI',
  [ModelProvider.ANTHROPIC]: 'Anthropic',
  openRouter: 'OpenRouter',
  [ModelProvider.GOOGLE]: 'Google',
  [ModelProvider.XAI]: 'xAI',
  [ModelProvider.DEEPSEEK]: 'DeepSeek',
  [ModelProvider.MOONSHOT]: 'Moonshot',
  [ModelProvider.DASHSCOPE]: 'DashScope',
  wolframllmapp: 'Wolfram',
  [ModelProvider.COPILOT]: 'Copilot',
  [ModelProvider.OTHERS]: 'Others',
};

/** Providers shown in the model selection list (display order). */
export const MODEL_PROVIDERS_ORDER: ModelProvider[] = [
  ModelProvider.OPENAI,
  ModelProvider.ANTHROPIC,
  ModelProvider.GOOGLE,
  ModelProvider.XAI,
  ModelProvider.DEEPSEEK,
  ModelProvider.MOONSHOT,
  ModelProvider.DASHSCOPE,
];

/** Default model used for instruction polishing. */
export const DEFAULT_POLISH_MODEL = 'sonnet45';
