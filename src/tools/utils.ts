// Local imports - common
import { ToolError } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Trim a string and throw a ToolError if the result is empty.
 * Centralizes the common pattern of validating non-empty input strings.
 */
export function requireNonEmptyString(
  value: string | null | undefined,
  fieldName = 'Value',
): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new ToolError(`${fieldName} cannot be empty.`);
  }
  return trimmed;
}

/**
 * Wrap an async API call and convert any error to a ToolError.
 * Simplifies the common try-catch-rethrow-as-ToolError pattern.
 * ToolErrors from nested calls pass through unwrapped so the original
 * message and cause chain survive.
 */
export async function wrapApiCall<T>(
  operation: () => Promise<T>,
  errorPrefix: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`${errorPrefix}: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }
}
