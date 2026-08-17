// Third-party imports
import stripAnsi from 'strip-ansi';

/**
 * Length cap (chars) for captured terminal output. Terminal hosts apply this
 * through {@link truncateTerminalOutput}; tools use it to describe that same
 * contract without importing a host layer.
 */
export const TERMINAL_OUTPUT_MAX_CHARS = 12_000;

/**
 * Strip ANSI control sequences and retain the bounded tail of terminal output.
 */
export function truncateTerminalOutput(output: string): string {
  const stripped = stripAnsi(output);
  return stripped.length > TERMINAL_OUTPUT_MAX_CHARS
    ? stripped.slice(-TERMINAL_OUTPUT_MAX_CHARS)
    : stripped;
}
