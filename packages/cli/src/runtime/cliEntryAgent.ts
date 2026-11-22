/** The agent a terminal launch starts. */
import { Effect } from 'effect';

import { envVar } from '@texra-ai/harness/node';
import type { AgentConfig } from '@texra-ai/harness/schemas';
import { entryAgent } from '@texra/agent/entryAgent';

import { VALIDATION_AGENT, VALIDATION_SWITCH } from './models/validationSwitch';

/**
 * The entry agent; a validation build started with {@link VALIDATION_AGENT}
 * starts the agent that names instead, which its launch resolves.
 */
export const cliEntryAgent: Effect.Effect<
  Pick<AgentConfig, 'agent' | 'agentSource'>
> = Effect.gen(function* () {
  const named =
    (yield* envVar(VALIDATION_SWITCH)) === '1'
      ? yield* envVar(VALIDATION_AGENT)
      : undefined;
  return named ? { agent: named } : entryAgent();
});
