import type { IconName } from '@ui/wa/iconNames';

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
  readonly icon: IconName;
  readonly label: string;
}
