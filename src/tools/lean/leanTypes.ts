/**
 * Host-neutral contracts shared by the VS Code and direct-LSP Lean adapters.
 * LSP shapes stay structural so this boundary does not depend on the packaging
 * details of `vscode-languageserver-protocol`.
 */

// Local imports - utils
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

// Constants and commands

/** Marketplace ID of the Lean 4 VS Code extension. */
export const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/** Per-file commands surfaced by `lean_file`. */
export const LEAN_FILE_COMMANDS = Object.freeze([
  'restart',
  'refresh_dependencies',
] as const);
export type LeanFileCommand = (typeof LEAN_FILE_COMMANDS)[number];

/** Project-scope commands surfaced by `lean_project`. */
export const LEAN_PROJECT_COMMANDS = Object.freeze([
  // Server commands
  'restart_server',
  'stop_server',
  // Project commands
  'build',
  'clean',
  'fetch_cache',
  'fetch_file_cache',
  // Setup commands
  'install_elan',
  'install_deps',
  'update_elan',
  'select_toolchain',
] as const);
export type LeanProjectCommand = (typeof LEAN_PROJECT_COMMANDS)[number];

/** Human-readable label for each server mode (used in the dashboard surface). */
export const LEAN_SERVER_MODE_LABELS = Object.freeze({
  'vscode-extension': LEAN4_EXTENSION_ID,
  'direct-lsp': 'direct LSP',
} as const);

// LSP contracts

type LspMarkupContent = {
  kind: 'plaintext' | 'markdown' | string;
  value: string;
};

type LspMarkedString = string | { language: string; value: string };

export interface LspHover {
  contents: LspMarkedString | LspMarkupContent | LspMarkedString[];
  range?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspPosition {
  line: number;
  character: number;
}

// Lean tool contracts

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

// Helpers

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(
  contents: LspHover['contents'],
): string | null {
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
