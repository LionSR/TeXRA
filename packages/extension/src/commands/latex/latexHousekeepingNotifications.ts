// Local imports
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import type { IndentLatexResult } from '@latex/formatter/indentDirectory';

interface LatexHousekeepingNotification {
  // "message" maps to showLoggedMessage, which uses VS Code's error toast.
  severity: 'info' | 'message' | 'error';
  message: string;
  error?: unknown;
}

export function getIndentTeXNotification(
  result: IndentLatexResult,
): LatexHousekeepingNotification | undefined {
  switch (result.status) {
    case 'missing-config':
      return {
        severity: 'message',
        message: `Formatter config file not found at ${result.configPath}`,
      };
    case 'error':
      return {
        severity: 'error',
        message: 'Error during indentation process',
        error: result.error,
      };
    case 'disabled':
    case 'formatted':
      return undefined;
  }
}

export async function showLatexHousekeepingNotification(
  channel: string,
  notification: LatexHousekeepingNotification,
): Promise<void> {
  switch (notification.severity) {
    case 'info':
      await showLoggedInfoMessage(channel, notification.message);
      return;
    case 'error':
      await showLoggedErrorMessage(
        channel,
        notification.message,
        notification.error,
      );
      return;
    case 'message':
      await showLoggedMessage(channel, notification.message);
      return;
  }
}
