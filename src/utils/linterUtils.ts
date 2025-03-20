// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import {
  getRelativePath,
  getFullPathFromWorkspace,
} from './workspaceFileUtils';

const CHANNEL = 'LinterUtils';
logger.initialize(CHANNEL);

/**
 * Get linter diagnostics for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Array of diagnostic information
 */
export function getDiagnostics(filePath: string): vscode.Diagnostic[] {
  try {
    // Convert relative path to absolute path
    const fullPath = getFullPathFromWorkspace(filePath);

    // Convert to Uri to match diagnostics format
    const fileUri = vscode.Uri.file(fullPath);

    // Get all diagnostics for the file from VS Code
    const diagnostics = vscode.languages.getDiagnostics(fileUri);

    logger.debug(
      CHANNEL,
      `Retrieved ${diagnostics.length} diagnostics for ${filePath}`,
    );
    return diagnostics;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error getting diagnostics for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Get formatted linter messages for a file
 * @param filePath Path to the file
 * @returns Array of formatted error/warning messages
 */
export function getLinterMessages(filePath: string): {
  message: string;
  line: number;
  column: number;
  severity: string;
  source: string;
}[] {
  try {
    const diagnostics = getDiagnostics(filePath);

    return diagnostics.map((diagnostic) => {
      const severity = getSeverityString(diagnostic.severity);
      return {
        message: diagnostic.message,
        line: diagnostic.range.start.line + 1, // Convert to 1-based line numbers
        column: diagnostic.range.start.character + 1, // Convert to 1-based column numbers
        severity,
        source: diagnostic.source || 'unknown',
      };
    });
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting linter messages for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Convert diagnostic severity to a readable string
 */
function getSeverityString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'unknown';
  }
}

/**
 * Count diagnostics by severity for a file
 */
export function countDiagnosticsBySeverity(filePath: string): {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
} {
  try {
    const diagnostics = getDiagnostics(filePath);

    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
    };

    diagnostics.forEach((diagnostic) => {
      switch (diagnostic.severity) {
        case vscode.DiagnosticSeverity.Error:
          counts.errors++;
          break;
        case vscode.DiagnosticSeverity.Warning:
          counts.warnings++;
          break;
        case vscode.DiagnosticSeverity.Information:
          counts.info++;
          break;
        case vscode.DiagnosticSeverity.Hint:
          counts.hints++;
          break;
      }
    });

    return counts;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error counting diagnostics for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { errors: 0, warnings: 0, info: 0, hints: 0 };
  }
}
