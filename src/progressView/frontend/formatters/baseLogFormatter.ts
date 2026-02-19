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
