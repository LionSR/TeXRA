/**
 * Host-neutral contracts shared by the VS Code and direct-LSP Lean adapters.
 * LSP shapes stay structural so this boundary does not depend on the packaging
 * details of `vscode-languageserver-protocol`.
 */

// Third-party imports
import { Schema } from 'effect';

// Local imports - utils
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';

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
} satisfies Record<string, LeanProjectCommandSpec>);
export type LeanProjectCommand = keyof typeof LEAN_PROJECT_COMMANDS;

/** Human-readable label for each server mode (used in the dashboard surface). */
export const LEAN_SERVER_MODE_LABELS = Object.freeze({
  'vscode-extension': LEAN4_EXTENSION_ID,
  'direct-lsp': 'direct LSP',
} as const);

// LSP contracts

const LspPositionSchema = Schema.Struct({
  line: Schema.Finite,
  character: Schema.Finite,
});

const LspRangeSchema = Schema.Struct({
  start: LspPositionSchema,
  end: LspPositionSchema,
});
type LspRange = typeof LspRangeSchema.Type;

const LspMarkedStringSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ language: Schema.String, value: Schema.String }),
]);

/** Reply to `textDocument/hover`. */
export const LspHoverSchema = Schema.Struct({
  contents: Schema.Union([
    LspMarkedStringSchema,
    Schema.Struct({ kind: Schema.String, value: Schema.String }),
    Schema.Array(LspMarkedStringSchema),
  ]),
  range: Schema.optional(LspRangeSchema),
});
export type LspHover = typeof LspHoverSchema.Type;

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

/**
 * Lean's `$/lean/fileProgress` notification: the ranges of the document
 * version still being elaborated. `kind` 1 (or absent) is processing, 2 a
 * fatal error that will not finish; nothing processing means elaborated.
 */
export interface LeanFileProgressParams {
  textDocument: { uri: string; version: number };
  processing: { range: LspRange; kind?: number }[];
}

// Lean tool contracts

/** Response from $/lean/plainGoal LSP request */
export const PlainGoalSchema = Schema.Struct({
  goals: Schema.Array(Schema.String),
  rendered: Schema.String,
});
export type PlainGoal = typeof PlainGoalSchema.Type;

/** Response from $/lean/plainTermGoal LSP request */
export const PlainTermGoalSchema = Schema.Struct({ goal: Schema.String });
export type PlainTermGoal = typeof PlainTermGoalSchema.Type;

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
 * A file's diagnostics, the answer of
 * {@link LeanLanguageServices.fetchDiagnosticsForFile}. A file that could not
 * be opened and a Lean that could not serve it are that call's failures, not
 * values here.
 */
export interface FetchDiagnosticsResult {
  readonly diagnostics: LeanDiagnostic[];
  /**
   * False when Lean had not reported the file elaborated by the end of the
   * wait: `diagnostics` are the ones so far, not the file's verdict.
   */
  readonly complete: boolean;
}

/**
 * Lean cannot serve the call: no Lake project above the file, no usable
 * toolchain (no `lake` to start a server, no Lean 4 extension), or the
 * server stopped under the call (a crash included). The message says which,
 * and carries the setup advice where the toolchain is the cause.
 */
export class LeanUnavailable extends Schema.TaggedError<LeanUnavailable>()(
  'LeanUnavailable',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The file to diagnose could not be read or opened. */
export class LeanFileUnreadable extends Schema.TaggedError<LeanFileUnreadable>()(
  'LeanFileUnreadable',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** A `lean_file` command ran into a failure of its own, reported by `message`. */
export class LeanFileCommandFailed extends Schema.TaggedError<LeanFileCommandFailed>()(
  'LeanFileCommandFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Helpers

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(contents: LspHover['contents']): string {
  if (typeof contents === 'string') {
    return contents;
  }

  if ('value' in contents) {
    return contents.value;
  }

  return contents
    .map((item) => (typeof item === 'string' ? item : item.value))
    .join('\n\n');
}
