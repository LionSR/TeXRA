import { spawn, type ChildProcess } from 'node:child_process';

import { extractErrorMessage } from '@utils/errors/errorMessage';

export interface BrowserLaunchCommand {
  readonly command: string;
  readonly args: string[];
}

interface BrowserLog {
  debug(channel: string, message: string): void;
}

export function resolveBrowserLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserLaunchCommand {
  switch (platform) {
    case 'darwin':
      return {
        command: 'open',
        args: [url],
      };
    case 'win32':
      // Avoid `cmd /c start` so percent-encoded OAuth and compare URLs are not
      // reparsed as cmd environment-variable expansions.
      return {
        command: 'rundll32',
        args: ['url.dll,FileProtocolHandler', url],
      };
    default:
      return {
        command: 'xdg-open',
        args: [url],
      };
  }
}

function launchBrowser(url: string): Promise<void> {
  const launch = resolveBrowserLaunch(url);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: 'ignore',
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
        new Error(`${launch.command} exited with code ${code ?? 'unknown'}`),
      );
    });
    child.once('error', rejectBrowserLaunch);

    function rejectBrowserLaunch(error: unknown): void {
      const message =
        extractErrorMessage(error) ?? 'unknown browser launch error';
      reject(new Error(`Could not open the browser automatically: ${message}`));
    }
  });
}

export function openBrowser(
  url: string,
  log: BrowserLog | undefined,
  manualBrowserHint: string,
): Promise<void> {
  return launchBrowser(url).catch((error: unknown) => {
    const message =
      extractErrorMessage(error) ?? 'unknown browser launch error';
    log?.debug('cli-auth', message);
    throw new Error(
      `${message}. Run ${manualBrowserHint} to open the sign-in URL manually.`,
    );
  });
}

export async function tryOpenBrowser(url: string): Promise<boolean> {
  try {
    await launchBrowser(url);
    return true;
  } catch {
    return false;
  }
}
