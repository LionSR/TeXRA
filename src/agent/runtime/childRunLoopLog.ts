// The child run loop's diagnostic writer.

import { Effect } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { withLogChannel } from '@logger/effectLog';

const CHANNEL = 'childRunLoop';

const EFFECT_LOG = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

/**
 * Write one loop diagnostic. An agent-CLI child presents them on its own
 * trace; every other child has no loop-owned stream, so they go to the
 * process log under this module's channel.
 */
export function loopLog(
  trace: AgentTrace | undefined,
  level: keyof typeof EFFECT_LOG,
  message: string,
  data?: unknown,
): Effect.Effect<void> {
  if (trace) {
    return Effect.sync(() =>
      trace[level](message, data === undefined ? undefined : { data }),
    );
  }
  const entry = EFFECT_LOG[level](message).pipe(withLogChannel(CHANNEL));
  return data === undefined ? entry : Effect.annotateLogs(entry, { data });
}
