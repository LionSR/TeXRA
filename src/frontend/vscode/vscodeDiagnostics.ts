/**
 * Shared VS Code diagnostics utilities.
 *
 * Provides common helpers for waiting on, counting, and formatting VS Code diagnostics,
 * used by both Lean and LaTeX tooling.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

const CHANNEL = 'VscodeDiagnostics';

// ============================================================================
// Types
// ============================================================================

/** Counts of diagnostics by severity level */
export interface SeverityCounts {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
}

// Re-export DiagnosticSeverity for tool implementations
export { DiagnosticSeverity } from 'vscode';

// ============================================================================
// Waiting
// ============================================================================

/**
 * Wait for diagnostics to change for a specific file.
 * Uses event subscription with timeout.
 *
 * @param uri - The file URI to watch for diagnostic changes
 * @param timeoutMs - Maximum time to wait (default 3000ms)
 * @returns Promise that resolves when diagnostics change or timeout
 */
export async function waitForDiagnosticsChange(
  uri: vscode.Uri,
  timeoutMs: number = 3000,
): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }

  const targetKey = uri.toString().toLowerCase();

  await new Promise<void>((resolve) => {
    let settled = false;

    const disposable = vscode.languages.onDidChangeDiagnostics((event) => {
      const hasMatch = event.uris.some(
        (eventUri) => eventUri.toString().toLowerCase() === targetKey,
      );
      if (hasMatch) {
        finish();
      }
    });

    const timeoutHandle = setTimeout(() => {
      logger.debug(CHANNEL, `Timed out waiting for diagnostics: ${uri.fsPath}`);
      finish();
    }, timeoutMs);

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      disposable.dispose();
      resolve();
    }
  });
}

// ============================================================================
// Counting
// ============================================================================

/** Map from severity number to label */
const SEVERITY_LABELS: Record<vscode.DiagnosticSeverity, string> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

/**
 * Get the string label for a severity level.
 */
export function getSeverityLabel(severity: vscode.DiagnosticSeverity): string {
  return SEVERITY_LABELS[severity] ?? 'unknown';
}

/** Map from severity to counts key */
const SEVERITY_TO_COUNT_KEY: Record<
  vscode.DiagnosticSeverity,
  keyof SeverityCounts
> = {
  [vscode.DiagnosticSeverity.Error]: 'errors',
  [vscode.DiagnosticSeverity.Warning]: 'warnings',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hints',
};

/**
 * Count diagnostics by severity level.
 */
export function countBySeverity(
  diagnostics: vscode.Diagnostic[],
): SeverityCounts {
  const counts: SeverityCounts = { errors: 0, warnings: 0, info: 0, hints: 0 };

  for (const d of diagnostics) {
    const key = SEVERITY_TO_COUNT_KEY[d.severity];
    if (key) counts[key]++;
  }

  return counts;
}

// ============================================================================
// Formatting
// ============================================================================

/** Pluralization rules for severity counts */
const COUNT_LABELS: Array<{
  key: keyof SeverityCounts;
  singular: string;
  plural: string;
}> = [
  { key: 'errors', singular: 'error', plural: 'errors' },
  { key: 'warnings', singular: 'warning', plural: 'warnings' },
  { key: 'info', singular: 'info', plural: 'info' },
  { key: 'hints', singular: 'hint', plural: 'hints' },
];

/**
 * Format severity counts as a human-readable summary string.
 * Example: "3 errors, 2 warnings, 1 hint"
 */
export function formatCounts(counts: SeverityCounts): string {
  const parts = COUNT_LABELS.filter(({ key }) => counts[key] > 0).map(
    ({ key, singular, plural }) => {
      const count = counts[key];
      return `${count} ${count === 1 ? singular : plural}`;
    },
  );

  return parts.length > 0 ? parts.join(', ') : 'No issues';
}

/**
 * Format diagnostics as indented message list.
 * Example:
 *   10: [error] Unexpected token
 *   15: [warning] Unused variable
 */
export function formatMessageList(diagnostics: vscode.Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const line = d.range.start.line + 1;
      const label = getSeverityLabel(d.severity);
      return `  ${line}: [${label}] ${d.message}`;
    })
    .join('\n');
}

/**
 * Format diagnostics grouped by severity as markdown sections.
 * Example:
 * ## Errors (2)
 *
 * **Line 10:** Unexpected token
 * **Line 20:** Missing semicolon
 */
export function formatGroupedSections(
  diagnostics: vscode.Diagnostic[],
): string {
  const errors = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Error,
  );
  const warnings = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Warning,
  );
  const hints = diagnostics.filter(
    (d) =>
      d.severity === vscode.DiagnosticSeverity.Information ||
      d.severity === vscode.DiagnosticSeverity.Hint,
  );

  const formatSection = (title: string, items: vscode.Diagnostic[]): string => {
    if (items.length === 0) return '';
    const lines = items
      .map((d) => `**Line ${d.range.start.line + 1}:** ${d.message}`)
      .join('\n\n');
    return `## ${title} (${items.length})\n\n${lines}`;
  };

  return [
    formatSection('Errors', errors),
    formatSection('Warnings', warnings),
    formatSection('Info/Hints', hints),
  ]
    .filter(Boolean)
    .join('\n\n');
}
