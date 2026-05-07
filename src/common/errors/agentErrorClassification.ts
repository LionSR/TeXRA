import { toErrorMessage } from './errorMessage';
import { isDiskFullError } from './errorPredicates';
import { isUserAbort } from './sdkErrorUtils';

export type AgentErrorKind =
  | 'abort'
  | 'disk-full'
  | 'missing-api-key'
  | 'unexpected';

/** Classify agent execution errors for consistent runtime notification policy. */
export function classifyAgentError(err: unknown): AgentErrorKind {
  if (isUserAbort(err)) return 'abort';
  if (isDiskFullError(err)) return 'disk-full';

  const msg = toErrorMessage(err);
  if (msg.includes('Missing API key') || msg.includes('API key not found')) {
    return 'missing-api-key';
  }

  return 'unexpected';
}
