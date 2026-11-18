import type { IconName } from '@ui/wa/iconNames';

export const AGENT_DECORATORS = Object.freeze({
  properties: Object.freeze({
    // `star`, not a person glyph: `circle-user` is already the Account glyph
    // inside the same settings window, and this row is rendered as the
    // custom-agent badge in Settings -> Agents.
    custom: Object.freeze({
      icon: 'star',
      label: 'Custom',
      hint: 'Custom agent: User-defined in your agents directory',
    }),
    plugin: Object.freeze({
      icon: 'cube',
      label: 'Plugin',
      hint: 'Plugin agent: From an installed Claude Code or Codex plugin',
    }),
  }),
  /** An agent run: a document task, or a chat. */
  agentRuns: Object.freeze({
    task: Object.freeze({ icon: 'cube', label: 'Document task' }),
    chat: Object.freeze({ icon: 'screwdriver-wrench', label: 'Chat' }),
  }),
  streamKinds: Object.freeze({
    process: Object.freeze({ icon: 'terminal', label: 'Process' }),
    script: Object.freeze({ icon: 'code', label: 'Script' }),
  }),
} as const);

export interface RunDecorator {
  readonly icon: IconName;
  readonly label: string;
}
