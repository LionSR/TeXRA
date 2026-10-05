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

/**
 * One command surfaced by a Lean tool. `description` is both the line the tool
 * prose shows for the command and the summary on its executed result; `hint` is
 * extra usage guidance carried only by the prose, where length is cheap.
 */
export interface LeanCommandSpec {
  readonly description: string;
  readonly hint?: string;
}

/** A `lean_project` command additionally names the prose section it lists under. */
interface LeanProjectCommandSpec extends LeanCommandSpec {
  readonly group: string;
}

/**
 * Freeze a command table and every spec in it. `Object.freeze` is shallow, so
 * the entries need freezing too before the table crosses a module boundary.
 */
function freezeCommands<T extends Record<string, LeanCommandSpec>>(
  commands: T,
): Readonly<T> {
  for (const spec of Object.values(commands)) Object.freeze(spec);
  return Object.freeze(commands);
}

/**
 * Per-file commands surfaced by `lean_file`, in declaration order. Single
 * source of truth: the tool's input enum, its prose, and its result summaries
 * all derive from this table (see `LspTools.ts`).
 */
export const LEAN_FILE_COMMANDS = freezeCommands({
  restart: {
    description: 'Restart Lean server for this file',
    hint: 'use when diagnostics are stale or after editing imports',
  },
  refresh_dependencies: {
    description: 'Refresh file dependencies without full restart',
    hint: 'lighter than restart',
  },
});
export type LeanFileCommand = keyof typeof LEAN_FILE_COMMANDS;

/**
 * Project-scope commands surfaced by `lean_project`, in declaration order.
 * Same single-source role as {@link LEAN_FILE_COMMANDS}, plus the `group` that
 * sections the generated prose.
 */
export const LEAN_PROJECT_COMMANDS = freezeCommands({
  restart_server: {
    group: 'Server',
    description: 'Restart the entire Lean language server',
  },
  stop_server: {
    group: 'Server',
    description: 'Stop the Lean language server',
  },
  build: {
    group: 'Project',
    description: 'Build the project (runs lake build)',
  },
  clean: { group: 'Project', description: 'Clean project build artifacts' },
  fetch_cache: {
    group: 'Project',
    description: 'Download Mathlib build cache for the project',
  },
  fetch_file_cache: {
    group: 'Project',
    description: "Download Mathlib cache for current file's imports only",
    hint: 'faster',
  },
  install_elan: {
    group: 'Setup',
    description: 'Install Elan (Lean version manager)',
  },
  install_deps: { group: 'Setup', description: 'Install Lean dependencies' },
  update_elan: {
    group: 'Setup',
    description: 'Update Elan to latest version',
  },
  select_toolchain: {
    group: 'Setup',
    description: 'Select default Lean toolchain version',
  },
} satisfies Record<string, LeanProjectCommandSpec>);
export type LeanProjectCommand = keyof typeof LEAN_PROJECT_COMMANDS;

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

/**
 * Result of {@link LeanLanguageServices.fetchDiagnosticsForFile}. A
 * discriminated result so callers can tell a genuinely missing/unopenable file
 * apart from a broken or absent Lean toolchain (no `lake`/`lean`, or the file
 * is not inside a Lake project) — the two failure modes the old
 * `LeanDiagnostic[] | null` contract conflated, which forced every failure to
 * read as "could not open file".
 */
export type FetchDiagnosticsResult =
  | { readonly ok: true; readonly diagnostics: LeanDiagnostic[] }
  | {
      readonly ok: false;
      readonly kind: 'file_missing' | 'toolchain_unavailable';
      readonly message: string;
    };

// Helpers

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(contents: LspHover['contents']): string {
  if (typeof contents === 'string') {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents
      .map((item) => (typeof item === 'string' ? item : item.value))
      .join('\n\n');
  }

  return contents.value;
}
