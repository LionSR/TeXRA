import { Cause, Effect } from 'effect';

import { writeErrorStderr } from '@cli/runtime/logSinks';

/**
 * Discriminated result of {@link withCliAuthError}: `ok: true` carries the
 * value, `ok: false` means the call failed and the error was already written
 * to stderr.
 */
type CliAuthResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Fold one scoped network/auth call, mapping failures to the CLI's
 * `ModelOrNetworkError` exit code in a single place. Commands scope the fold
 * to just the network call (so success-path code such as payload emission or
 * cache invalidation still runs); this turns its `writeErrorStderr` + exit-code
 * return into a discriminated result the caller narrows with one
 * `if (!result.ok) return CliExitCode.ModelOrNetworkError;` line. The fold is
 * over the whole cause: a defect is as much "this call produced no session" as
 * a typed failure, and both reach the user as the same stderr report.
 */
export function withCliAuthError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<CliAuthResult<A>, never, R> {
  return effect.pipe(
    Effect.matchCause({
      onFailure: (cause): CliAuthResult<A> => {
        writeErrorStderr(Cause.squash(cause));
        return { ok: false };
      },
      onSuccess: (value): CliAuthResult<A> => ({ ok: true, value }),
    }),
  );
}
