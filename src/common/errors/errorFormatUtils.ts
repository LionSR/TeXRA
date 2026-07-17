import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = truncateWithEllipsis(toErrorMessage(err), MAX_ERROR_LENGTH);
  return `${prefix}: ${detail}`;
}
