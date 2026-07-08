/**
 * Model provider decorator configuration - single source of truth for provider indicators.
 * Used in model dropdowns to visually distinguish different AI providers.
 */
export interface ProviderDecorator {
  unicode: string;
  label: string;
  hint: string;
}

const MODEL_PROVIDER_DECORATORS: Record<string, ProviderDecorator> = {
  anthropic: {
    unicode: '\u{1D538}', // 𝔸 - Double-struck A
    label: 'Anthropic',
    hint: 'Anthropic Claude models',
  },
  openai: {
    unicode: '\u2B21', // ⬡ - Hexagon
    label: 'OpenAI',
    hint: 'OpenAI GPT models',
  },
  google: {
    unicode: '\u{1D53E}', // 𝔾 - Double-struck G
    label: 'Google',
    hint: 'Google Gemini models',
  },
  xai: {
    unicode: '\u{1D54F}', // 𝕏 - Double-struck X
    label: 'xAI',
    hint: 'xAI Grok models',
  },
  deepseek: {
    unicode: '\u{1F433}', // 🐳 - Whale
    label: 'DeepSeek',
    hint: 'DeepSeek models',
  },
  moonshot: {
    unicode: '\u{1D542}', // 𝕂 - Double-struck K (for Kimi)
    label: 'Moonshot',
    hint: 'Moonshot AI Kimi models',
  },
  dashscope: {
    unicode: '\u2604', // ☄ - Comet (Alibaba Cloud)
    label: 'Qwen',
    hint: 'Alibaba Cloud Qwen models',
  },
  copilot: {
    unicode: '\u2387', // ⎇ - Alternative key (GitHub)
    label: 'Copilot',
    hint: 'GitHub Copilot models',
  },
  others: {
    unicode: '\u25C7', // ◇ - Diamond
    label: 'Other',
    hint: 'Other model providers',
  },
};

export function getModelProviderDecorator(provider: string): ProviderDecorator {
  return (
    MODEL_PROVIDER_DECORATORS[provider] ?? MODEL_PROVIDER_DECORATORS.others
  );
}

export const AGENT_DECORATORS = {
  properties: {
    remote: {
      icon: 'cloud',
      label: 'Remote',
      hint: 'Remote agent: Prompts loaded from cloud',
    },
    custom: {
      icon: 'account',
      label: 'Custom',
      hint: 'Custom agent: User-defined in your agents directory',
    },
  },
  agentCategories: {
    workflow: { icon: 'symbol-method', label: 'Workflow' },
    toolUse: { icon: 'tools', label: 'Tool Use' },
  },
} as const;

type AgentCategory = keyof typeof AGENT_DECORATORS.agentCategories;

export function getAgentCategoryDecorator(
  agentCategory: string | undefined,
): (typeof AGENT_DECORATORS.agentCategories)[AgentCategory] {
  const categories = AGENT_DECORATORS.agentCategories;
  return (
    (agentCategory && categories[agentCategory as AgentCategory]) ||
    categories.workflow
  );
}
