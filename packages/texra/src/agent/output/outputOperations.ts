import { Effect } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { AgentTrace } from '@texra-ai/harness/plugins';

interface RecoverOptions<T, R> {
  /** Trace used for the warning. */
  logger: AgentTrace;
  /**
   * Prefix for the warning. The resolved error message is appended as
   * `${label}: ${toErrorMessage(err)}`.
   */
  label: string;
  /** Produces the fallback value (and any side effects) after logging. */
  recover: (error: unknown) => Effect.Effect<T, never, R>;
}

/**
 * Shared `run → warn → recover` combinator for an optional step of the output
 * pipeline. A **typed** failure of `effect` is logged on the transcript as a
 * warning, `${label}: ${message}`, then replaced by the caller's fallback —
 * the fallback is loud by construction, never silent.
 *
 * Defects and interruption deliberately pass straight through: a bug in this
 * pipeline is not a recoverable output failure, and a cancelled run is not a
 * skipped step. The one broad recovery left is the documents plugin's own
 * fallback, which owns what a failed output round reports.
 */
export const recoverOutputFailure =
  <T, R2 = never>(options: RecoverOptions<T, R2>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | T, never, R | R2> =>
    Effect.catch(effect, (error: E) =>
      Effect.suspend(() => {
        options.logger.warn(`${options.label}: ${toErrorMessage(error)}`);
        return options.recover(error);
      }),
    );
