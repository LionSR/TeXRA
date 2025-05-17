// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { getFullPathFromWorkspace } from './workspaceFileUtils';
import { sleep } from './timeUtils';

const CHANNEL = 'LinterUtils';
logger.initialize(CHANNEL);

// Define a type for the linter message
export type LinterMessage = {
  message: string;
  line: number;
  column: number;
  severity: string;
  source: string;
};

/**
 * Trigger a LaTeX build for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Promise resolving when build is triggered
 */
export async function triggerLaTeXBuild(filePath: string): Promise<void> {
  try {
    if (!filePath.toLowerCase().endsWith('.tex')) {
      return; // Only trigger for TeX files
    }

    // Get the full path and create URI for the specific file
    const fullPath = getFullPathFromWorkspace(filePath);
    const fileUri = vscode.Uri.file(fullPath);

    // First, make sure the file is open in an editor
    let editor: vscode.TextEditor | undefined;
    try {
      // Try to find if file is already open
      editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === fullPath,
      );

      // If not open, open it
      if (!editor) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        editor = await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: true,
        });
        logger.debug(CHANNEL, `Opened file in editor: ${filePath}`);
      }

      // Make sure the file is saved
      if (editor.document.isDirty) {
        await editor.document.save();
        logger.debug(CHANNEL, `Saved file: ${filePath}`);
      }
    } catch (openErr) {
      logger.warn(
        CHANNEL,
        `Could not open file in editor: ${openErr instanceof Error ? openErr.message : String(openErr)}`,
      );
      // Continue anyway - we'll still try to trigger the build
    }

    logger.debug(
      CHANNEL,
      `Triggering LaTeX build for ${filePath} to refresh linter diagnostics`,
    );

    // Trigger the build
    await vscode.commands.executeCommand('latex-workshop.build', fileUri);

    // Wait for the build and diagnostics to complete
    await sleep(2500);

    // Try to trigger diagnostics refresh explicitly if the editor is available
    if (editor) {
      // Save the file again after build to ensure diagnostics are refreshed
      await editor.document.save();
      logger.debug(CHANNEL, `Saved file after build: ${filePath}`);
    }

    // Wait a bit more for diagnostics to be updated
    await sleep(500);
  } catch (buildErr) {
    logger.warn(
      CHANNEL,
      `Failed to trigger LaTeX build: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
    );
    // Continue anyway, as we'll use whatever diagnostics are available
  }
}

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
export async function getLinterMessages(
  filePath: string,
): Promise<LinterMessage[]> {
  try {
    // First trigger LaTeX build for TeX files to refresh diagnostics
    if (filePath.toLowerCase().endsWith('.tex')) {
      await triggerLaTeXBuild(filePath);
    }

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
