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

/** Default model used for auxiliary/helper tasks (polishing, agent creation, merge, session descriptions). */
export const DEFAULT_HELPER_MODEL = 'sonnet45';

/** Shape for a VS Code boolean setting surfaced per provider (without runtime value). */
export interface ProviderVscodeSettingDef {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly warning?: string;
  readonly warningUrl?: string;
  readonly warningUrlLabel?: string;
}

/** VS Code config settings to surface per provider in the Models tab. */
export const PROVIDER_VSCODE_SETTINGS: Record<
  string,
  ProviderVscodeSettingDef[]
> = {
  openai: [
    {
      key: 'texra.model.gpt5ReasoningSummary',
      label: 'GPT-5 Reasoning Summary',
      description:
        'Request reasoning summaries from GPT-5 models. Only available on OpenAI API Tier 3+.',
      warning:
        'New accounts with $20 credit are typically Tier 1 and will hit rate limits.',
      warningUrl:
        'https://platform.openai.com/settings/organization/billing/overview',
      warningUrlLabel: 'Check your tier',
    },
    {
      key: 'texra.model.useOpenAIResponsesAPI',
      label: 'Use Responses API',
      description:
        'Use the OpenAI Responses API instead of Chat Completions when available.',
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background Responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
    },
    {
      key: 'texra.model.openaiParallelToolCalls',
      label: 'Parallel Tool Calls',
      description:
        'Allow the model to call multiple tools in parallel. Off by default to preserve sequential tool execution.',
    },
  ],
  anthropic: [
    {
      key: 'texra.model.useAnthropic1MBeta',
      label: '1M Context Window Beta',
      description:
        'Enable the 1M-token context window for Claude Opus 4.6, Sonnet 4.6, and Sonnet 4 (usage capped at 200K by extension).',
    },
  ],
};

/** URLs for obtaining API keys from each provider. */
export const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/',
  openRouter: 'https://openrouter.ai/keys',
  google: 'https://aistudio.google.com/app/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  moonshot: 'https://platform.moonshot.cn/console',
  dashscope: 'https://dashscope.aliyun.com/api-console/',
  wolframllmapp: 'https://llm-api.wolframalpha.com/',
};
