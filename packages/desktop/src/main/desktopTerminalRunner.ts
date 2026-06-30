// Local imports - hosts
import {
  TERMINAL_OUTPUT_MAX_CHARS,
  truncateTerminalOutput,
  type TerminalRunner,
  type TerminalRunRequest,
} from '@hosts/uiHosts';

// Local imports - system
import { executeCommand } from '@utils/system/execUtils';

const RAW_OUTPUT_MAX_CHARS = TERMINAL_OUTPUT_MAX_CHARS * 2;

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
      const appendOutput = (chunk: string) => {
        output += chunk;
        if (output.length > RAW_OUTPUT_MAX_CHARS) {
          output = output.slice(-RAW_OUTPUT_MAX_CHARS);
        }
      };
      const result = await executeCommand(request.command, {
        cwd: request.cwd ?? options.cwd,
        env: normalizeEnv(request.env),
        timeout: request.timeoutMs,
        channel: request.name,
        truncate: true,
        buffer: false,
        onStdout: appendOutput,
        onStderr: appendOutput,
      });
      const bufferedOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n');

      return {
        exitCode: result.exitCode,
        output: truncateTerminalOutput(output || bufferedOutput),
        timedOut: result.timedOut ?? false,
      };
    },
  };
}

function normalizeEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
