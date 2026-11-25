import { failureIn } from '@common/errors/sdkError/providerErrorFormat';
import type { RunEnd } from '@shared/schemas';

/**
 * Runtime aggregates put the primary failure first and retain later cleanup
 * failures for diagnostics. Follow that ordering through nested aggregates.
 */
export function primaryAgentError(err: unknown): unknown {
  while (err instanceof AggregateError) err = err.errors[0];
  return err;
}

/** A run's failure as its `run.end` row records it ({@link failureIn}). */
export function classifyAgentError(err: unknown): NonNullable<RunEnd['error']> {
  return failureIn(primaryAgentError(err));
}
