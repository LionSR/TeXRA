// Local imports - common
import { ToolError } from '@shared/schemas/toolResult';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for empty needles.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

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
 * Validate that a field is not null/undefined for a given command.
 * Centralizes the common pattern of validating required parameters in tool execute methods.
 */
export function requireField<T>(
  value: T | null | undefined,
  fieldName: string,
  command: string,
): T {
  if (value == null) {
    throw new ToolError(
      `Parameter \`${fieldName}\` is required for command: ${command}`,
    );
  }
  return value;
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
