import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';

import { isDiskFullError } from './errorPredicates';
import { hasMissingApiKeyErrorMarker } from './sdkError/errorMetadata';
import { isContextWindowError, isUserAbort } from './sdkError/errorPatterns';

export type AgentErrorKind =
  'abort' | 'context-window' | 'disk-full' | 'missing-api-key' | 'unexpected';

/**
 * Canonical outcome of a run terminated by a thrown error, per error kind.
 * `abort` is the only cancellation — every other kind is a failure. Keep this
 * a declarative table so new kinds must take an explicit stance.
 */
export const AGENT_ERROR_OUTCOME: Readonly<Record<AgentErrorKind, RunOutcome>> =
  {
    abort: RUN_OUTCOME.CANCELLED,
    'context-window': RUN_OUTCOME.FAILED,
    'disk-full': RUN_OUTCOME.FAILED,
    'missing-api-key': RUN_OUTCOME.FAILED,
    unexpected: RUN_OUTCOME.FAILED,
  };

/**
 * Classify agent execution errors for consistent runtime notification policy.
 *
 * Every kind is decided by a typed signal — an SDK/abort predicate, an errno,
 * or a `Symbol.for` marker attached at the throw site. Only
 * `isContextWindowError` still consults message text, and only for the
 * third-party providers whose SDKs expose no error code for the overflow.
 */
export function classifyAgentError(err: unknown): AgentErrorKind {
  if (isUserAbort(err)) return 'abort';
  if (isDiskFullError(err)) return 'disk-full';
  if (hasMissingApiKeyErrorMarker(err)) return 'missing-api-key';
  if (isContextWindowError(err)) return 'context-window';

  return 'unexpected';
}
