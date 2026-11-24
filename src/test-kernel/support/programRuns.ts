// Local imports
import type { AgentConfig } from '@shared/schemas';

/**
 * `config` opened on the theory plugin's `annotate` program, as a launcher
 * builds a program's run: named for the program, with the caller's other
 * fields as the case wrote them.
 */
export function asProgramRun<C extends Partial<AgentConfig>>(config: C) {
  return {
    ...config,
    label: 'annotate',
    script: { kind: 'program', name: 'annotate', args: {} },
  } as const;
}
