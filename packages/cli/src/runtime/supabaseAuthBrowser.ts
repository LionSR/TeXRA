// Standard library imports
import { spawn, type ChildProcess } from 'node:child_process';

// Type imports - platform
import type { LogBackend } from '@platform/interfaces/log';

function quoteWindowsStartUrl(url: string): string {
  return url.replaceAll('"', '%22');
}

export function openBrowser(
  url: string,
  log: LogBackend | undefined,
  manualBrowserHint: string,
): Promise<void> {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'cmd';
      args = ['/d', '/s', '/c', `start "" "${quoteWindowsStartUrl(url)}"`];
      break;
    default:
      command = 'xdg-open';
      args = [url];
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        windowsVerbatimArguments: process.platform === 'win32',
      });
    } catch (error) {
      rejectBrowserLaunch(error);
      return;
    }

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      rejectBrowserLaunch(
        new Error(`${command} exited with code ${code ?? 'unknown'}`),
      );
    });
    child.once('error', rejectBrowserLaunch);

    function rejectBrowserLaunch(error: unknown): void {
      const message =
        error instanceof Error ? error.message : 'unknown browser launch error';
      log?.debug?.(
        'cli-auth',
        `Could not open browser automatically: ${message}`,
      );
      reject(
        new Error(
          `Could not open the browser automatically: ${message}. Run ${manualBrowserHint} to open the sign-in URL manually.`,
        ),
      );
    }
  });
}
