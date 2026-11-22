import type { IconName } from '@ui/wa/iconNames';

export const AGENT_DECORATORS = Object.freeze({
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
