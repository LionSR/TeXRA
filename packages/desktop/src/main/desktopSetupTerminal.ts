// Third-party imports
import { quote } from 'shell-quote';

// Internal imports
import { executeCommand } from '@utils/system/execUtils';

const OPEN_TERMINAL_TIMEOUT_MS = 10_000;

export function setupCommandNeedsInteractiveTerminal(command: string): boolean {
  return /(^|[\s;&|()])sudo($|[\s;&|()])/.test(command);
}

export async function openMacTerminalCommand(
  command: string,
  cwd: string,
): Promise<void> {
  const terminalCommand = buildMacTerminalCommand(command, cwd);
  const result = await executeCommand(
    [
      'osascript',
      '-e',
      'tell application "Terminal"',
      '-e',
      'activate',
      '-e',
      `do script "${escapeAppleScriptString(terminalCommand)}"`,
      '-e',
      'end tell',
    ],
    { cwd, timeout: OPEN_TERMINAL_TIMEOUT_MS, stdout: 'ignore' },
  );

  if (result.timedOut) {
    throw new Error('Timed out opening Terminal');
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        `Could not open Terminal; osascript exited ${result.exitCode}`,
    );
  }
}

export function buildMacTerminalCommand(command: string, cwd: string): string {
  return `cd ${quote([cwd])} && ${command}`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
