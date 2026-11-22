/** The run a terminal launch starts. */
import { Effect, Schema } from 'effect';

import { envVar } from '@texra-ai/harness/node';
import { entryAgent } from '@texra/agent/entryAgent';
import type { ChatLaunch } from '@texra/shared/session/surface';

import { VALIDATION_AGENT, VALIDATION_SWITCH } from './models/validationSwitch';

/** What {@link VALIDATION_AGENT} holds: the run, written inline. */
const ValidationAgentJson = Schema.fromJsonString(
  Schema.Struct({
    label: Schema.String,
    system: Schema.String,
    tools: Schema.Array(Schema.String),
  }),
);

/**
 * The entry agent; a validation build started with {@link VALIDATION_AGENT}
 * starts the run that variable writes instead (a malformed one is a defect
 * of the script that set it).
 */
export const cliEntryAgent: Effect.Effect<ChatLaunch> = Effect.gen(
  function* () {
    const written =
      (yield* envVar(VALIDATION_SWITCH)) === '1'
        ? yield* envVar(VALIDATION_AGENT)
        : undefined;
    if (!written) return entryAgent();
    const run = Schema.decodeUnknownSync(ValidationAgentJson)(written);
    return { ...run, temperature: 1 };
  },
);
