// Internal imports
import { toErrorMessage } from '@common/errors';
import { executeCommand } from '@utils/system/execUtils';

export interface BrowserLaunchCommand {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments: boolean;
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
        windowsVerbatimArguments: false,
      };
    case 'win32':
      // Avoid `cmd /c start` so percent-encoded OAuth and compare URLs are not
      // reparsed as cmd environment-variable expansions.
      return {
        command: 'rundll32',
        args: ['url.dll,FileProtocolHandler', url],
        windowsVerbatimArguments: false,
      };
    default:
      return {
        command: 'xdg-open',
        args: [url],
        windowsVerbatimArguments: false,
      };
  }
}

async function launchBrowser(url: string): Promise<void> {
  const launch = resolveBrowserLaunch(url);
  const result = await executeCommand([launch.command, ...launch.args]);
  if (result.exitCode === 0) return;
  const message = result.stderr ?? `exited with code ${result.exitCode}`;
  throw new Error(
    `Could not open the browser automatically: ${launch.command} ${message}`,
  );
}

export function openBrowser(
  url: string,
  log: BrowserLog | undefined,
  manualBrowserHint: string,
): Promise<void> {
  return launchBrowser(url).catch((error: unknown) => {
    const message = toErrorMessage(error);
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
