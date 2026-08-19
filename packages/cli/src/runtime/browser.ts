import { execa } from 'execa';

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

async function launchBrowser(url: string): Promise<void> {
  const launch = resolveBrowserLaunch(url);
  // reject: false — a spawn failure (no `xdg-open` on a headless box) and a
  // non-zero exit are the same "could not open a browser" outcome here.
  const result = await execa(launch.command, launch.args, {
    stdio: 'ignore',
    reject: false,
  });
  if (!result.failed) return;
  // `cause` carries the spawn error ("spawn xdg-open ENOENT"); execa's own
  // `message` is not used because it embeds the argv, and the argv is the
  // sign-in URL.
  const message =
    extractErrorMessage(result.cause) ??
    `${launch.command} exited with code ${result.exitCode ?? 'unknown'}`;
  throw new Error(`Could not open the browser automatically: ${message}`);
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
