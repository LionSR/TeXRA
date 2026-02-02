/**
 * Base log formatter utilities for open state management and error handling.
 */

export type FormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

/** Safely execute a formatting function with error handling. */
export function safeFormat<T>(
  formatter: () => T,
  errorContext: string,
): T | null {
  try {
    return formatter();
  } catch (e) {
    console.error(`Error parsing ${errorContext}:`, e);
    return null;
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
