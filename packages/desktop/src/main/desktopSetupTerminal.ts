// Third-party imports
import { spawn } from 'node:child_process';

const OPEN_TERMINAL_TIMEOUT_MS = 10_000;

export function setupCommandNeedsInteractiveTerminal(command: string): boolean {
  return /(^|[\s;&|()])sudo($|[\s;&|()])/.test(command);
}

export async function openMacTerminalCommand(
  command: string,
  cwd: string,
): Promise<void> {
  const terminalCommand = buildMacTerminalCommand(command, cwd);
  const child = spawn(
    'osascript',
    [
      '-e',
      'tell application "Terminal"',
      '-e',
      'activate',
      '-e',
      `do script "${escapeAppleScriptString(terminalCommand)}"`,
      '-e',
      'end tell',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out opening Terminal'));
    }, OPEN_TERMINAL_TIMEOUT_MS);
    const finish = (callback: () => void) => {
      clearTimeout(timeoutId);
      callback();
    };
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(() =>
        reject(
          new Error(
            stderr.trim() ||
              `Could not open Terminal; osascript exited ${code}`,
          ),
        ),
      );
    });
  });
}

export function buildMacTerminalCommand(command: string, cwd: string): string {
  return `cd ${quotePosixShellArg(cwd)} && ${command}`;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
