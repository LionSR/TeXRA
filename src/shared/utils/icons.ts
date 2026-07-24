import type { TeXRAIconName } from '@shared/wa/webAwesomeIcons';

/**
 * Model provider decorator configuration - single source of truth for provider indicators.
 * Used in model dropdowns to visually distinguish different AI providers.
 *
 * Icon choices (FA-solid, via the texra wa-icon resolver — see #8157): free-solid
 * ships no brand marks, so providers with a name-adjacent glyph get one
 * (DeepSeek's mascot is a whale -> closest free-solid analog `fish`; Moonshot ->
 * `moon`; OpenAI's mark is a hexagonal knot -> `hexagon`; Google's model line is
 * "Gemini" -> `gem`; GitHub Copilot flies alongside you -> `plane`; Alibaba's
 * prior glyph was a comet -> `meteor`). Everyone else (Anthropic, xAI, and the
 * "other" fallback) gets a neutral glyph from the same set instead of a forced,
 * unrelated metaphor.
 */
export interface ProviderDecorator {
  icon: TeXRAIconName;
  label: string;
  hint: string;
}

const MODEL_PROVIDER_DECORATORS: Record<string, ProviderDecorator> = {
  anthropic: {
    icon: 'brain',
    label: 'Anthropic',
    hint: 'Anthropic Claude models',
  },
  openai: {
    icon: 'hexagon',
    label: 'OpenAI',
    hint: 'OpenAI GPT models',
  },
  google: {
    icon: 'gem',
    label: 'Google',
    hint: 'Google Gemini models',
  },
  xai: {
    icon: 'satellite',
    label: 'xAI',
    hint: 'xAI Grok models',
  },
  deepseek: {
    icon: 'fish',
    label: 'DeepSeek',
    hint: 'DeepSeek models',
  },
  moonshot: {
    icon: 'moon',
    label: 'Moonshot',
    hint: 'Moonshot AI Kimi models',
  },
  dashscope: {
    icon: 'meteor',
    label: 'Qwen',
    hint: 'Alibaba Cloud Qwen models',
  },
  copilot: {
    icon: 'plane',
    label: 'Copilot',
    hint: 'GitHub Copilot models',
  },
  others: {
    icon: 'robot',
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
  streamKinds: {
    workflowScript: { icon: 'list-tree', label: 'Workflow Script' },
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
