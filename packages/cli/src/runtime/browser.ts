// Standard library imports
import { spawn, type ChildProcess } from 'node:child_process';

export interface BrowserLaunchCommand {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments: boolean;
}

interface BrowserLog {
  debug(channel: string, message: string): void;
}

function quoteWindowsStartUrl(url: string): string {
  return url.replaceAll('"', '%22').replaceAll('%', '^%');
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
        windowsVerbatimArguments: false,
      };
    case 'win32':
      return {
        command: 'cmd',
        args: ['/d', '/s', '/c', `start "" "${quoteWindowsStartUrl(url)}"`],
        windowsVerbatimArguments: true,
      };
    default:
      return {
        command: 'xdg-open',
        args: [url],
        windowsVerbatimArguments: false,
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
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
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
        error instanceof Error ? error.message : 'unknown browser launch error';
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
      error instanceof Error ? error.message : 'unknown browser launch error';
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
