export const CHEVRON_UP_CLASS = 'codicon codicon-chevron-up';
export const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
export const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';

/**
 * Model provider decorator configuration - single source of truth for provider indicators.
 * Used in model dropdowns to visually distinguish different AI providers.
 */
export interface ProviderDecorator {
  unicode: string;
  label: string;
  hint: string;
}

export const MODEL_PROVIDER_DECORATORS: Record<string, ProviderDecorator> = {
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
    label: 'DashScope',
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

/**
 * Get the decorator config for a model provider.
 */
export function getModelProviderDecorator(provider: string): ProviderDecorator {
  return (
    MODEL_PROVIDER_DECORATORS[provider] ?? MODEL_PROVIDER_DECORATORS.others
  );
}

/**
 * Agent decorator configuration - single source of truth for all agent indicators.
 */
export interface AgentDecorator {
  icon: string;
  unicode: string;
  label: string;
  hint?: string;
}

export const AGENT_DECORATORS = {
  properties: {
    remote: {
      icon: 'cloud',
      unicode: '☁',
      label: 'Remote',
      hint: 'Remote agent: Prompts loaded from cloud',
    },
    custom: {
      icon: 'account',
      unicode: '★',
      label: 'Custom',
      hint: 'Custom agent: User-defined in your agents directory',
    },
    multipleOutputs: {
      icon: 'files',
      unicode: '⧉',
      label: 'Multiple outputs',
      hint: 'Has _multiple variant that supports multiple output files',
    },
  },
  agentCategories: {
    workflow: { icon: 'symbol-method', unicode: '▷', label: 'Workflow' },
    toolUse: { icon: 'tools', unicode: '🔧', label: 'Tool Use' },
  },
} as const;

export type AgentCategory = keyof typeof AGENT_DECORATORS.agentCategories;

/**
 * Build a codicon CSS class string from an icon name.
 */
export function getCodiconClass(iconName: string): string {
  return `codicon codicon-${iconName}`;
}

/**
 * Get codicon classes as an object for use with Lit's classMap directive.
 * @example
 * import { classMap } from 'lit/directives/class-map.js';
 * html`<i class=${classMap(getCodiconClasses('chevron-down'))}></i>`
 */
export function getCodiconClasses(iconName: string): Record<string, boolean> {
  return {
    codicon: true,
    [`codicon-${iconName}`]: true,
  };
}

/**
 * Apply codicon classes to an element.
 * @deprecated Use getCodiconClasses() with classMap directive for Lit-native patterns.
 */
export function applyCodiconClass(
  element: HTMLElement,
  iconName: string,
): void {
  element.classList.add('codicon', `codicon-${iconName}`);
}

/**
 * Get the decorator config for an agent category.
 */
export function getAgentCategoryDecorator(
  agentCategory: string | undefined,
): (typeof AGENT_DECORATORS.agentCategories)[AgentCategory] {
  const categories = AGENT_DECORATORS.agentCategories;
  if (agentCategory && agentCategory in categories) {
    return categories[agentCategory as AgentCategory];
  }
  return categories.workflow;
}
