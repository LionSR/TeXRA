// Local imports
import type { IndentLatexResult, LatexdiffPackResult } from '@housekeeping';

export interface LatexHousekeepingNotification {
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
    default:
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
      case 'processed':
        return [];
    }
  });
}
