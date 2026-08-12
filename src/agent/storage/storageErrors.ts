/**
 * Throw the single error as-is, or wrap multiple into one AggregateError.
 *
 * Shared by the storage write/cleanup paths (registration writes, adjacent
 * stream-state cleanups) so the single-vs-multiple unwrap stays in one place
 * instead of being re-derived at each `Promise.allSettled` site.
 */
export function throwUnwrapAggregate(
  errors: unknown[],
  message: string,
): asserts errors is [] {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}
