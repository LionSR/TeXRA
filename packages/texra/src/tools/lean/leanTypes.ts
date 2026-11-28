/**
 * Host-neutral contracts between the Lean tools and the `lake` server pool.
 * LSP shapes stay structural so this boundary does not depend on the packaging
 * details of `vscode-languageserver-protocol`.
 */

// Third-party imports
import { Schema } from 'effect';

// Local imports - utils
import type { GenericDiagnostic } from '@texra/tools/diagnosticFormatting';

// Constants and commands

/** Marketplace ID of the Lean 4 VS Code extension. */
export const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/**
 * One `lean_project` command: `description` is both the line the tool prose
 * shows for the command and the summary on its executed result; `group` is
 * the prose section it lists under.
 */
interface LeanProjectCommandSpec {
  readonly group: string;
  readonly description: string;
}

/**
 * Project-scope commands surfaced by `lean_project`, in declaration order.
 * Single source of truth: the tool's input enum, its prose, and its result
 * summaries all derive from this table (see `LspTools.ts`). Each spec is
 * frozen too: `Object.freeze` is shallow, and the table crosses a module
 * boundary.
 */
export const LEAN_PROJECT_COMMANDS = Object.freeze({
  restart_server: Object.freeze({
    group: 'Server',
    description: 'Restart the entire Lean language server',
  }),
  stop_server: Object.freeze({
    group: 'Server',
    description: 'Stop the Lean language server',
  }),
  build: Object.freeze({
    group: 'Project',
    description: 'Build the project (runs lake build)',
  }),
  clean: Object.freeze({
    group: 'Project',
    description: 'Clean project build artifacts',
  }),
  fetch_cache: Object.freeze({
    group: 'Project',
    description: 'Download Mathlib build cache for the project',
  }),
} satisfies Record<string, LeanProjectCommandSpec>);
export type LeanProjectCommand = keyof typeof LEAN_PROJECT_COMMANDS;

// LSP contracts

const LspPositionSchema = Schema.Struct({
  line: Schema.Finite,
  character: Schema.Finite,
});

export const LspRangeSchema = Schema.Struct({
  start: LspPositionSchema,
  end: LspPositionSchema,
});

const LspMarkedStringSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ language: Schema.String, value: Schema.String }),
]);

/** Reply to `textDocument/hover`. */
const LspHoverSchema = Schema.Struct({
  contents: Schema.Union([
    LspMarkedStringSchema,
    Schema.Struct({ kind: Schema.String, value: Schema.String }),
    Schema.Array(LspMarkedStringSchema),
  ]),
  range: Schema.optional(LspRangeSchema),
});

// Lean tool contracts

/** Response from $/lean/plainGoal LSP request */
const PlainGoalSchema = Schema.Struct({
  goals: Schema.Array(Schema.String),
  rendered: Schema.String,
});

/** Response from $/lean/plainTermGoal LSP request */
const PlainTermGoalSchema = Schema.Struct({ goal: Schema.String });

/**
 * What `lean_inspect` asks Lean at a position, by inspection: the LSP request
 * and the schema of Lean's non-null answer. The tool's input enum is this
 * table's keys.
 */
export const LEAN_INSPECTIONS = Object.freeze({
  goal: Object.freeze({ method: '$/lean/plainGoal', reply: PlainGoalSchema }),
  term_goal: Object.freeze({
    method: '$/lean/plainTermGoal',
    reply: PlainTermGoalSchema,
  }),
  hover: Object.freeze({ method: 'textDocument/hover', reply: LspHoverSchema }),
});
export type LeanInspection = keyof typeof LEAN_INSPECTIONS;
/** Lean's answer to the inspection `K`. */
export type LeanInspectionReply<K extends LeanInspection> =
  (typeof LEAN_INSPECTIONS)[K]['reply']['Type'];

/**
 * A file's diagnostics, the answer of
 * {@link LeanLanguageServices.fetchDiagnosticsForFile}. A file that could not
 * be opened and a Lean that could not serve it are that call's failures, not
 * values here.
 */
export interface FetchDiagnosticsResult {
  readonly diagnostics: GenericDiagnostic[];
  /**
   * False when Lean had not reported the file elaborated by the end of the
   * wait: `diagnostics` are the ones so far, not the file's verdict.
   */
  readonly complete: boolean;
  /** The file's text as Lean was sent it: what `diagnostics` describe. */
  readonly text: string;
}

/**
 * Lean cannot serve the call: no Lake project above the file, no usable
 * toolchain (no `lake` to start a server), or the
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

/** The file could not be read or opened. */
export class LeanFileUnreadable extends Schema.TaggedError<LeanFileUnreadable>()(
  'LeanFileUnreadable',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Helpers

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(
  contents: LeanInspectionReply<'hover'>['contents'],
): string {
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
