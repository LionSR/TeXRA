import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';

import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDiskFullError } from './errorPredicates';
import { isUserAbort } from './sdkErrorUtils';

export type AgentErrorKind =
  'abort' | 'disk-full' | 'missing-api-key' | 'unexpected';

/**
 * Canonical outcome of a run terminated by a thrown error, per error kind.
 * `abort` is the only cancellation — every other kind is a failure. Keep this
 * a declarative table so new kinds must take an explicit stance.
 */
export const AGENT_ERROR_OUTCOME: Readonly<Record<AgentErrorKind, RunOutcome>> =
  {
    abort: RUN_OUTCOME.CANCELLED,
    'disk-full': RUN_OUTCOME.FAILED,
    'missing-api-key': RUN_OUTCOME.FAILED,
    unexpected: RUN_OUTCOME.FAILED,
  };

/** Classify agent execution errors for consistent runtime notification policy. */
export function classifyAgentError(err: unknown): AgentErrorKind {
  if (isUserAbort(err)) return 'abort';
  if (isDiskFullError(err)) return 'disk-full';

  const msg = toErrorMessage(err);
  if (msg.includes('Missing API key') || msg.includes('No API key found')) {
    return 'missing-api-key';
  }

  return 'unexpected';
}
