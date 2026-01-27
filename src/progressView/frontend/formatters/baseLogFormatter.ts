/**
 * Base log formatter utilities for open state management and error handling.
 */

type FormatOptions = {
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

/** Resolve whether a details element should be open. */
export function resolveOpenState(
  messageType: string,
  options: FormatOptions | undefined,
  autoExpandedTypes: Set<string>,
): boolean | undefined {
  if (!options) return undefined;

  // Preserved state takes precedence
  if (options.preservedOpen !== undefined) return options.preservedOpen;

  // Auto-expand certain types when defaultOpen is set
  if (options.defaultOpen && autoExpandedTypes.has(messageType)) return true;

  return undefined;
}
