import type { TeXRAIconName } from '@shared/iconNames';

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
interface ProviderDecorator {
  icon: TeXRAIconName;
  label: string;
}

const MODEL_PROVIDER_DECORATORS: Record<string, ProviderDecorator> = {
  anthropic: { icon: 'brain', label: 'Anthropic' },
  openai: { icon: 'hexagon', label: 'OpenAI' },
  google: { icon: 'gem', label: 'Google' },
  xai: { icon: 'satellite', label: 'xAI' },
  deepseek: { icon: 'fish', label: 'DeepSeek' },
  moonshot: { icon: 'moon', label: 'Moonshot' },
  dashscope: { icon: 'meteor', label: 'Qwen' },
  copilot: { icon: 'plane', label: 'Copilot' },
  others: { icon: 'robot', label: 'Other' },
};

export function getModelProviderDecorator(provider: string): ProviderDecorator {
  return (
    MODEL_PROVIDER_DECORATORS[provider] ?? MODEL_PROVIDER_DECORATORS.others
  );
}

export const AGENT_DECORATORS = {
  properties: {
    // `star`, not a person glyph: `circle-user` is already the Account glyph
    // inside the same settings window, and this row is rendered as the
    // custom-agent badge in Settings -> Agents.
    custom: {
      icon: 'star',
      label: 'Custom',
      hint: 'Custom agent: User-defined in your agents directory',
    },
    plugin: {
      icon: 'cube',
      label: 'Plugin',
      hint: 'Plugin agent: From an installed Claude Code or Codex plugin',
    },
  },
  /** An agent run: a document task, or a chat. */
  agentRuns: {
    task: { icon: 'cube', label: 'Document task' },
    chat: { icon: 'screwdriver-wrench', label: 'Chat' },
  },
  streamKinds: {
    process: { icon: 'terminal', label: 'Process' },
    script: { icon: 'code', label: 'Script' },
  },
} as const;

export interface RunDecorator {
  readonly icon: TeXRAIconName;
  readonly label: string;
}
