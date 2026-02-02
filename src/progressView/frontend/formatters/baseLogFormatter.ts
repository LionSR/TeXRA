/**
 * Base log formatter utilities for open state management and error handling.
 */

export type FormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

/** Result of safeFormat - either success with value or failure with error. */
export type SafeFormatResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Safely execute a formatting function with error handling. */
export function safeFormat<T>(
  formatter: () => T,
  errorContext: string,
): SafeFormatResult<T> {
  try {
    const value = formatter();
    return { ok: true, value };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`Error parsing ${errorContext}:`, e);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Determine whether a details element should be open.
 * Returns undefined when no preference is set, allowing formatters to use their own defaults.
 */
export function shouldBeOpen(
  messageType: string,
  options: FormatOptions | undefined,
  autoExpandedTypes: Set<string>,
): boolean | undefined {
  if (!options) return undefined;
  if (options.preservedOpen !== undefined) return options.preservedOpen;
  if (options.defaultOpen && autoExpandedTypes.has(messageType)) return true;
  return undefined;
}
