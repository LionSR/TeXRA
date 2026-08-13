// Local imports
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import type { LatexdiffPackResult } from '@housekeeping/packLatexdiffvc';
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

export function getLatexdiffPackNotifications(
  results: LatexdiffPackResult | LatexdiffPackResult[],
): LatexHousekeepingNotification[] {
  return (Array.isArray(results) ? results : [results]).flatMap((result) => {
    switch (result.status) {
      case 'no-files':
        return {
          severity: 'info',
          message: 'No LaTeX diff files found to process',
        };
      case 'cleaned':
        return {
          severity: 'info',
          message: 'LaTeXdiff files cleaned',
        };
      case 'packed':
        return {
          severity: 'info',
          message: `Files packed into ${result.outputFolder}`,
        };
      case 'missing-inputs':
        return {
          severity: 'message',
          message: 'No input files provided for multiple LaTeX diff packing',
        };
      case 'error':
        return {
          severity: 'error',
          message: `Error during packing ${result.inputFile}`,
          error: result.error,
        };
      case 'processed':
        return [];
    }
  });
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
