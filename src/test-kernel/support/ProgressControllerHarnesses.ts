// Local imports
import type { AgentConfig } from '@shared/schemas';

/**
 * `config` opened on the theory plugin's `edit` program, as a launcher
 * builds a document run: an inline `edit` persona the program runs under,
 * and the caller's other fields as the case wrote them.
 */
export function asDocumentTask<C extends Partial<AgentConfig>>(config: C) {
  return {
    ...config,
    agent: 'edit',
    agentSource: 'inline',
    persona: { name: 'edit' },
    script: { kind: 'program', name: 'edit', args: {} },
  } as const;
}
