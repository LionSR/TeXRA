import { Effect } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { MESSAGE_TYPES, type MessageType } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Trace levels that the output managers use for recoverable failures. */
type OutputLogLevel = 'error' | 'warn' | 'debug';

interface RecoverOptions<T, R> {
  /** Trace used for the internal failure line. */
  logger: AgentTrace;
  /** Trace level for the failure line (mirrors each call site's prior level). */
  level: OutputLogLevel;
  /**
   * Prefix for the failure line. The resolved error message is appended as
   * `${label}: ${toErrorMessage(err)}`.
   */
  label: string;
  /** Message category for the failure line. Defaults to INTERNAL. */
  messageType?: MessageType;
  /** Produces the fallback value (and any side effects) after logging. */
  recover: (error: unknown) => Effect.Effect<T, never, R>;
}

/**
 * Shared `run → log internal → recover` combinator for the output pipeline.
 * A **typed** failure of `effect` is logged as `${label}: ${message}` at
 * `level` with the INTERNAL message type, then replaced by the caller's
 * fallback — the fallback is loud by construction, never silent.
 *
 * Defects and interruption deliberately pass straight through: a bug in this
 * pipeline is not a recoverable output failure, and a cancelled run is not a
 * skipped step. The one broad recovery left is the reflection loop's own
 * `fallbackOutput`, which owns what a failed output round reports.
 */
export const recoverOutputFailure =
  <T, R2 = never>(options: RecoverOptions<T, R2>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | T, never, R | R2> =>
    Effect.catch(effect, (error: E) =>
      Effect.suspend(() => {
        options.logger[options.level](
          `${options.label}: ${toErrorMessage(error)}`,
          { messageType: options.messageType ?? MESSAGE_TYPES.INTERNAL },
        );
        return options.recover(error);
      }),
    );
