/**
 * VS Code-free types and pure functions shared between
 * the Lean tool implementations and the VS Code integration layer.
 */

import type { Hover } from 'vscode-languageserver-protocol';

/** Response from $/lean/plainGoal LSP request */
export interface PlainGoal {
  goals: string[];
  rendered: string;
}

/** Response from $/lean/plainTermGoal LSP request */
export interface PlainTermGoal {
  goal: string;
}

/** Typed result from an LSP request */
export interface LspResult<T> {
  data: T | null;
  error?: string;
}

/**
 * Platform-agnostic diagnostic representation.
 * Maps to vscode.Diagnostic fields used by formatting functions.
 */
export interface LeanDiagnostic {
  severity: number;
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
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

const SEVERITY_CONFIG: Record<
  number,
  { label: string; countKey: keyof SeverityCounts; plural: string }
> = {
  [SEVERITY_ERROR]: { label: 'error', countKey: 'errors', plural: 'errors' },
  [SEVERITY_WARNING]: {
    label: 'warning',
    countKey: 'warnings',
    plural: 'warnings',
  },
  [SEVERITY_INFO]: { label: 'info', countKey: 'info', plural: 'info' },
  [SEVERITY_HINT]: { label: 'hint', countKey: 'hints', plural: 'hints' },
};

const COUNT_KEY_ORDER: Array<keyof SeverityCounts> = [
  'errors',
  'warnings',
  'info',
  'hints',
];

/** Count diagnostics by severity level. */
export function countBySeverity(
  diagnostics: LeanDiagnostic[],
): SeverityCounts {
  const counts: SeverityCounts = { errors: 0, warnings: 0, info: 0, hints: 0 };
  for (const d of diagnostics) {
    const config = SEVERITY_CONFIG[d.severity];
    if (config) counts[config.countKey]++;
  }
  return counts;
}

/** Format severity counts as a human-readable summary string. */
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

/** Format diagnostics grouped by severity as markdown sections. */
export function formatGroupedSections(
  diagnostics: LeanDiagnostic[],
): string {
  const errors = diagnostics.filter((d) => d.severity === SEVERITY_ERROR);
  const warnings = diagnostics.filter((d) => d.severity === SEVERITY_WARNING);
  const hints = diagnostics.filter(
    (d) => d.severity === SEVERITY_INFO || d.severity === SEVERITY_HINT,
  );

  const formatSection = (
    title: string,
    items: LeanDiagnostic[],
  ): string => {
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

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(contents: Hover['contents']): string | null {
  if (typeof contents === 'string') {
    return contents;
  }

  if (Array.isArray(contents)) {
    const texts = contents.flatMap((item) => {
      if (typeof item === 'string') return item;
      if ('value' in item) return item.value;
      return [];
    });
    return texts.join('\n\n');
  }

  if ('value' in contents) {
    return contents.value;
  }

  return null;
}
