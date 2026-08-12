import { CliExitCode } from '@cli/runtime/exitCodes';
import { writeErrorStderr } from '@cli/runtime/logSinks';

/**
 * Discriminated result of {@link withCliAuthError}: `ok: true` carries the
 * value, `ok: false` means the thunk threw and the error was already written
 * to stderr.
 */
export type CliAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

/**
 * Run one scoped network/auth call, mapping failures to the CLI's
 * `ModelOrNetworkError` exit code in a single place. Commands scope the catch
 * to just the network call (so success-path code such as payload emission or
 * cache invalidation still runs); this folds that catch's `writeErrorStderr`
 * + exit-code return into a discriminated result the caller narrows with one
 * `if (!result.ok) return CliExitCode.ModelOrNetworkError;` line.
 */
export async function withCliAuthError<T>(
  fn: () => Promise<T>,
): Promise<CliAuthResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    writeErrorStderr(error);
    return { ok: false };
  }
}
