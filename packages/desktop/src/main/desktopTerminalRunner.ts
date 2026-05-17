// Third-party imports
import stripAnsi from 'strip-ansi';

// Local imports - hosts
import type { TerminalRunner, TerminalRunRequest } from '@hosts/terminalHost';

// Local imports - system
import { executeCommand } from '@utils/system/execUtils';

const OUTPUT_MAX_CHARS = 12_000;
const RAW_OUTPUT_MAX_CHARS = OUTPUT_MAX_CHARS * 2;

export interface DesktopTerminalRunnerOptions {
  cwd?: string;
}

/** Desktop implementation of the shared setup terminal-runner contract. */
export function createDesktopTerminalRunner(
  options: DesktopTerminalRunnerOptions = {},
): TerminalRunner {
  return {
    async runCommand(request: TerminalRunRequest) {
      let output = '';
      const appendOutput = (stream: 'stdout' | 'stderr', chunk: string) => {
        output += chunk;
        if (output.length > RAW_OUTPUT_MAX_CHARS) {
          output = output.slice(-RAW_OUTPUT_MAX_CHARS);
        }
        request.onOutput?.({ stream, chunk });
      };
      const result = await executeCommand(request.command, {
        cwd: request.cwd ?? options.cwd,
        env: normalizeEnv(request.env),
        timeout: request.timeoutMs,
        channel: request.name,
        truncate: true,
        buffer: false,
        signal: request.signal,
        onStdout: (chunk) => appendOutput('stdout', chunk),
        onStderr: (chunk) => appendOutput('stderr', chunk),
      });
      const bufferedOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n');

      return {
        exitCode: result.exitCode,
        output: tail(output || bufferedOutput),
        timedOut: result.timedOut ?? false,
        cancelled: request.signal?.aborted ?? false,
      };
    },
  };
}

function normalizeEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

function tail(output: string): string {
  const stripped = stripAnsi(output);
  return stripped.length > OUTPUT_MAX_CHARS
    ? stripped.slice(-OUTPUT_MAX_CHARS)
    : stripped;
}
