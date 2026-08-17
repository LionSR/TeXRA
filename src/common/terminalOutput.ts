// Third-party imports
import stripAnsi from 'strip-ansi';

/** Process-level character cap for integrated-terminal output capture. */
export const TERMINAL_OUTPUT_MAX_CHARS = 12_000;

/** Strip ANSI control sequences and retain the captured output tail. */
export function truncateTerminalOutput(output: string): string {
  const stripped = stripAnsi(output);
  return stripped.length > TERMINAL_OUTPUT_MAX_CHARS
    ? stripped.slice(-TERMINAL_OUTPUT_MAX_CHARS)
    : stripped;
}
