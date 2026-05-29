import type { AgentTrace } from '@agent/trace';
import { toErrorMessage } from '@common/errors';
import { MESSAGE_TYPES } from '@shared/schemas';

/** Trace levels that the output managers use for recoverable failures. */
type OutputLogLevel = 'error' | 'warn' | 'debug';

export interface TryOperationOptions<T> {
  /** Trace used for the internal failure line. */
  logger: AgentTrace;
  /** Trace level for the failure line (mirrors each call site's prior level). */
  level: OutputLogLevel;
  /**
   * Prefix for the failure line. The resolved error message is appended as
   * `${label}: ${toErrorMessage(err)}`, matching the previous hand-written
   * `catch` blocks.
   */
  label: string;
  /** Produces the fallback value (and any side effects) after logging. */
  recover: (error: unknown) => T | Promise<T>;
}

/**
 * Shared `try → log internal → recover` wrapper for the output operation
 * managers. Runs `operation`; on failure it logs
 * `${label}: ${toErrorMessage(err)}` at `level` with the INTERNAL message
 * type, then returns the caller-supplied recovery value. This centralizes the
 * identical error-recovery boilerplate that `LatexDiffManager`,
 * `OutputFileProcessor`, and friends each repeated.
 */
export async function tryOperation<T>(
  operation: () => Promise<T>,
  { logger, level, label, recover }: TryOperationOptions<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger[level](`${label}: ${toErrorMessage(error)}`, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    return recover(error);
  }
}
