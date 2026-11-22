// Local imports
import type { AgentConfig } from '@shared/schemas';

/**
 * `config` opened on the theory plugin's `edit` program, as a launcher
 * builds a document run: named for the program, with the caller's other
 * fields as the case wrote them.
 */
export function asDocumentTask<C extends Partial<AgentConfig>>(config: C) {
  return {
    ...config,
    label: 'edit',
    script: { kind: 'program', name: 'edit', args: {} },
  } as const;
}
