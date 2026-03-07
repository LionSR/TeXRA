/**
 * VS Code-free types and pure functions shared between
 * the Lean tool implementations and the VS Code integration layer.
 */

import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
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
 * Platform-agnostic diagnostic representation for Lean files.
 * Extends GenericDiagnostic with an optional source field.
 */
export interface LeanDiagnostic extends GenericDiagnostic {
  source?: string;
}

// Re-export formatting utilities for convenience.
export {
  countBySeverity,
  formatCounts,
  formatGroupedSections,
  type SeverityCounts,
} from '@utils/diagnostics/diagnosticFormatting';

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
