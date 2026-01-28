/**
 * Shared VS Code diagnostics utilities.
 *
 * Provides common helpers for waiting on, counting, and formatting VS Code diagnostics,
 * used by both Lean and LaTeX tooling.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

const CHANNEL = 'VscodeDiagnostics';

/** Counts of diagnostics by severity level */
export interface SeverityCounts {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
}

export { DiagnosticSeverity } from 'vscode';

/** Unified severity metadata for labels, counting, and formatting */
const SEVERITY_CONFIG: Record<
  vscode.DiagnosticSeverity,
  { label: string; countKey: keyof SeverityCounts; plural: string }
> = {
  [vscode.DiagnosticSeverity.Error]: {
    label: 'error',
    countKey: 'errors',
    plural: 'errors',
  },
  [vscode.DiagnosticSeverity.Warning]: {
    label: 'warning',
    countKey: 'warnings',
    plural: 'warnings',
  },
  [vscode.DiagnosticSeverity.Information]: {
    label: 'info',
    countKey: 'info',
    plural: 'info',
  },
  [vscode.DiagnosticSeverity.Hint]: {
    label: 'hint',
    countKey: 'hints',
    plural: 'hints',
  },
};

/** Ordered keys for consistent formatting output */
const COUNT_KEY_ORDER: Array<keyof SeverityCounts> = [
  'errors',
  'warnings',
  'info',
  'hints',
];

/**
 * Wait for diagnostics to change for a specific file.
 * Uses event subscription with timeout.
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

/** Get the string label for a severity level. */
export function getSeverityLabel(severity: vscode.DiagnosticSeverity): string {
  return SEVERITY_CONFIG[severity]?.label ?? 'unknown';
}

/** Count diagnostics by severity level. */
export function countBySeverity(
  diagnostics: vscode.Diagnostic[],
): SeverityCounts {
  const counts: SeverityCounts = { errors: 0, warnings: 0, info: 0, hints: 0 };

  for (const d of diagnostics) {
    const config = SEVERITY_CONFIG[d.severity];
    if (config) counts[config.countKey]++;
  }

  return counts;
}

/**
 * Format severity counts as a human-readable summary string.
 * Example: "3 errors, 2 warnings, 1 hint"
 */
export function formatCounts(counts: SeverityCounts): string {
  const parts: string[] = [];

  for (const key of COUNT_KEY_ORDER) {
    const count = counts[key];
    if (count > 0) {
      const config = Object.values(SEVERITY_CONFIG).find(
        (c) => c.countKey === key,
      );
      if (config) {
        parts.push(`${count} ${count === 1 ? config.label : config.plural}`);
      }
    }
  }

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
