export const CHEVRON_UP_CLASS = 'codicon codicon-chevron-up';
export const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
export const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';

/**
 * Agent decorator configuration - single source of truth for all agent indicators.
 * Used across dropdown, stream tabs, and history view.
 *
 * Each decorator has:
 * - icon: codicon name for use in places that support HTML (stream tabs, etc.)
 * - unicode: unicode character for use in dropdowns (vscode-option only supports text)
 * - label: human-readable label
 * - hint: tooltip text (optional)
 */
/**
 * Model provider decorator configuration - single source of truth for provider indicators.
 * Used in model dropdowns to visually distinguish different AI providers.
 *
 * Each decorator has:
 * - unicode: unicode character for use in dropdowns
 * - label: human-readable provider name
 * - hint: tooltip text describing the provider
 */
export const MODEL_PROVIDER_DECORATORS = {
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
 * @param {string} provider - Provider key (anthropic, openai, etc.)
 * @returns {{ unicode: string, label: string, hint: string }}
 */
export function getModelProviderDecorator(provider) {
  return (
    MODEL_PROVIDER_DECORATORS[provider] || MODEL_PROVIDER_DECORATORS.others
  );
}

export const AGENT_DECORATORS = {
  // Agent properties (remote, custom, multiple outputs)
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

  // Agent types (reasoning strategy)
  types: {
    CoT: {
      icon: 'list-tree',
      unicode: '⛓',
      label: 'Chain of Thought',
      hint: 'Shows reasoning in scratchpad before final response',
    },
    direct: {
      icon: 'lightbulb',
      unicode: '⚡',
      label: 'Direct',
      hint: 'Responds directly without scratchpad',
    },
    toolUse: {
      icon: 'tools',
      unicode: '🔧',
      label: 'Tool Use',
      hint: 'Can execute tools and code',
    },
    unknown: {
      icon: 'question',
      unicode: '?',
      label: 'Unknown',
      hint: 'Unknown agent type',
    },
  },

  // Agent categories (workflow vs tool-use)
  agentCategories: {
    workflow: { icon: 'symbol-method', unicode: '▷', label: 'Workflow' },
    toolUse: { icon: 'tools', unicode: '🔧', label: 'Tool Use' },
  },
};

/**
 * Build a codicon CSS class string from an icon name.
 * @param {string} iconName - Icon name (e.g., 'cloud', 'tools')
 * @returns {string} Full codicon class string
 */
export function getCodiconClass(iconName) {
  return `codicon codicon-${iconName}`;
}

/**
 * Apply codicon classes to an element.
 * @param {HTMLElement} element - The element to apply classes to
 * @param {string} iconName - Icon name (e.g., 'cloud', 'tools')
 */
export function applyCodiconClass(element, iconName) {
  element.classList.add('codicon', `codicon-${iconName}`);
}

/**
 * Get the decorator config for an agent type.
 * @param {string} agentType - Agent type key (CoT, direct, toolUse)
 * @returns {{ icon: string, label: string }}
 */
export function getAgentTypeDecorator(agentType) {
  return AGENT_DECORATORS.types[agentType] || AGENT_DECORATORS.types.unknown;
}

/**
 * Get the decorator config for an agent category.
 * @param {string} agentCategory - Agent category key (workflow, toolUse)
 * @returns {{ icon: string, label: string }}
 */
export function getAgentCategoryDecorator(agentCategory) {
  return (
    AGENT_DECORATORS.agentCategories[agentCategory] ||
    AGENT_DECORATORS.agentCategories.workflow
  );
}
