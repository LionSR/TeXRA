/**
 * Platform-agnostic diagnostic formatting utilities.
 *
 * Provides counting and formatting helpers that work with any diagnostic
 * object matching the `GenericDiagnostic` interface. Both VS Code diagnostics
 * and Lean tool diagnostics satisfy this interface.
 */

import { formatResultCount } from '@utils/text/stringUtils';

/**
 * Minimal diagnostic shape required by the formatting functions.
 * Compatible with `vscode.Diagnostic` and `LeanDiagnostic`.
 */
export interface GenericDiagnostic {
  severity: number;
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Counts of diagnostics by severity level */
export interface SeverityCounts {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
}

// Severity constants matching vscode.DiagnosticSeverity values
const SEVERITY_ERROR = 0;
const SEVERITY_WARNING = 1;
const SEVERITY_INFO = 2;
const SEVERITY_HINT = 3;

/**
 * Unified severity metadata for labels, counting, and formatting. The
 * `countKey` doubles as the plural label ('info' stays 'info'), and numeric
 * keys iterate in ascending order so `Object.values` gives formatting order.
 */
const SEVERITY_CONFIG: Record<
  number,
  { label: string; countKey: keyof SeverityCounts }
> = {
  [SEVERITY_ERROR]: { label: 'error', countKey: 'errors' },
  [SEVERITY_WARNING]: { label: 'warning', countKey: 'warnings' },
  [SEVERITY_INFO]: { label: 'info', countKey: 'info' },
  [SEVERITY_HINT]: { label: 'hint', countKey: 'hints' },
};

/** Get the string label for a severity level. */
export function getSeverityLabel(severity: number): string {
  return SEVERITY_CONFIG[severity]?.label ?? 'unknown';
}

/** Count diagnostics by severity level. */
export function countBySeverity(
  diagnostics: GenericDiagnostic[],
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
  const parts = Object.values(SEVERITY_CONFIG)
    .filter(({ countKey }) => counts[countKey] > 0)
    .map(({ label, countKey }) =>
      formatResultCount(counts[countKey], label, countKey),
    );
  return parts.length > 0 ? parts.join(', ') : 'No issues';
}

/**
 * Format diagnostics as indented message list.
 * Example:
 *   10: [error] Unexpected token
 *   15: [warning] Unused variable
 */
export function formatMessageList(diagnostics: GenericDiagnostic[]): string {
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
  diagnostics: GenericDiagnostic[],
): string {
  const sections: Array<[title: string, items: GenericDiagnostic[]]> = [
    ['Errors', diagnostics.filter((d) => d.severity === SEVERITY_ERROR)],
    ['Warnings', diagnostics.filter((d) => d.severity === SEVERITY_WARNING)],
    [
      'Info/Hints',
      diagnostics.filter(
        (d) => d.severity === SEVERITY_INFO || d.severity === SEVERITY_HINT,
      ),
    ],
  ];

  return sections
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => {
      const lines = items
        .map((d) => `**Line ${d.range.start.line + 1}:** ${d.message}`)
        .join('\n\n');
      return `## ${title} (${items.length})\n\n${lines}`;
    })
    .join('\n\n');
}
