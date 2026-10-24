import { Result, Schema, Struct } from 'effect';

import { JsonValueSchema } from './jsonValue';
import { LineChangesSchema } from './lineChanges';
import { Sha256Schema } from './offeredTools';

/**
 * Base schema for file references (metadata only, no binary data).
 * Used when binary data has been stripped for serialization/logging.
 */
const FileReferenceSchema = Schema.StructWithRest(
  Schema.Struct({
    /** Workspace-relative or descriptive path for the file */
    path: Schema.String,
    /** MIME type for the file */
    mimeType: Schema.String,
    /** Optional human readable description */
    description: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type FileReference = typeof FileReferenceSchema.Type;

/**
 * Schema for file attachments with optional binary data.
 * Extends FileReferenceSchema with binary payload fields.
 */
const ToolFileAttachmentSchema = FileReferenceSchema.mapFields(
  Struct.assign({
    /** Base64 encoded payload when inline transport is supported */
    base64Data: Schema.optional(Schema.String),
    /** Raw bytes for providers that require binary uploads */
    bytes: Schema.optional(Schema.instanceOf(Uint8Array)),
    /** Bytes the session store already holds under this address: a file a
     *  script relays from one of its calls' settled attachments. */
    digest: Schema.optional(Sha256Schema),
  }),
);
export type ToolFileAttachment = typeof ToolFileAttachmentSchema.Type;

/**
 * Schema for edit records in tool results.
 */
const EditRecordSchema = Schema.Struct({
  path: Schema.String,
  lineChanges: Schema.optional(LineChangesSchema),
  /** 1-based line number where the edit starts (for navigation) */
  startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type EditRecord = typeof EditRecordSchema.Type;

// ============================================================================
// Diagnostics Types (not Zod - these are complex unions with external types)
// ============================================================================

/**
 * Diagnostic type identifier for tool parameter validation errors.
 * Used when Zod validation fails on tool input parameters.
 */
export const DIAGNOSTIC_TYPE_VALIDATION_ERROR = 'validation_error' as const;

/**
 * Formatted Zod issue for model consumption.
 * Provides structured information that helps models self-correct. Every field
 * is JSON by construction: the settled tool result is stored as a JSON value,
 * and a present-but-undefined key there is a refused row, not a dropped key.
 */
const FormattedZodIssueSchema = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
  expected: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});
type FormattedZodIssue = typeof FormattedZodIssueSchema.Type;

/**
 * Structured validation error diagnostics. One of several shapes a tool's
 * `ToolResult.diagnostics` may carry (see that field's own comment) — this is
 * the one produced for Zod input-validation failures, used to provide rich
 * error information to models for self-correction.
 */
export const ValidationErrorDiagnosticsSchema = Schema.Struct({
  type: Schema.Literal(DIAGNOSTIC_TYPE_VALIDATION_ERROR),
  formatted: Schema.Array(FormattedZodIssueSchema),
});
export type ValidationErrorDiagnostics =
  (typeof ValidationErrorDiagnosticsSchema)['Type'];

/**
 * Format Zod issues into structured diagnostics for model consumption.
 * Only an `invalid_type` issue names an `expected` type, so only that issue
 * carries the key; Zod 4 issues report no `received` value at all.
 */
export function formatZodIssuesForDiagnostics(
  issues: ZodIssue[],
): FormattedZodIssue[] {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    ...(issue.code === 'invalid_type' ? { expected: issue.expected } : {}),
    code: issue.code,
  }));
}

// ============================================================================
// ToolResult Schema
// ============================================================================

/**
 * Schema for tool run results.
 * Every field a tool wants surfaced to the model must be declared below —
 * there is no catchall, so an undeclared field is silently stripped rather
 * than reaching `formatToolResultAsText`.
 */
const ToolResultSharedFields = {
  /** User instruction that was processed */
  userInstruction: Schema.optional(Schema.String),
  /**
   * Additional diagnostic information. Deliberately `z.unknown()`: every tool
   * shapes its own payload here (validation issues, severity counts, an
   * unread-file reason, an error name, …), so there is no single schema to
   * validate against. Consumers that care about one specific shape — e.g.
   * {@link ValidationErrorDiagnosticsSchema} — parse it themselves.
   */
  diagnostics: Schema.optional(Schema.Unknown),
  /** Summary added by handlers when attachments are available */
  attachmentSummary: Schema.optional(Schema.String),
};

/** A `plugin.fact` of one of the calling tool's plugin's arms
 *  (`Plugin.arms`), committed in its call's `tool.result` batch. */
const ToolFactSchema = Schema.Struct({
  plugin: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.String.check(Schema.isMinLength(1)),
  /** The arm's version `value` is written at. */
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  value: JsonValueSchema,
  /** The plugin's own aggregate the fact is about (`<plugin>:<key>`), hung
   *  under the calling run; absent, the fact is about the run itself. */
  aggregate: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
/** A fact a tool's call states about its run (`ToolFactSchema`). */
export type ToolFact = typeof ToolFactSchema.Type;

const ExecutedToolResultSchema = Schema.Struct({
  status: Schema.Literal('executed'),
  /** Detailed output from the tool */
  output: Schema.optional(Schema.String),
  /** Brief summary of the tool run result */
  summary: Schema.optional(Schema.String),
  /** End the current model turn after this successful tool result is paired. */
  endTurn: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Undefined),
  /** Records of edits made during tool run */
  edits: Schema.optional(Schema.Array(EditRecordSchema)),
  /** File attachments (may contain binary data) */
  files: Schema.optional(Schema.Array(ToolFileAttachmentSchema)),
  /** What a script's `await` gets for this call in place of
   *  `{ output, summary }`: a tool whose answer is data, not prose. */
  value: Schema.optional(JsonValueSchema),
  /** The key a later call of the same tool in this run may take this result
   *  under instead of running again; only an executed result carries one. */
  reuseKey: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  /** The call whose result this one took under its `reuseKey`. */
  reusedFrom: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  /** Follow-ups queued on the calling run that this result answers (a
   *  child's report a wait returned): consumed in the call's settlement
   *  batch, so they leave the run's input only with the result. Not stored
   *  on the result. */
  consumedFollowUps: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  ),
  /** Facts about the call's run, committed beside its `tool.result` as
   *  `plugin.fact` rows; never stored on the result itself. */
  facts: Schema.optional(Schema.Array(ToolFactSchema)),
  ...ToolResultSharedFields,
});

const ErrorToolResultSchema = Schema.Struct({
  status: Schema.Literal('error'),
  /** Error message if tool run failed */
  error: Schema.String.check(Schema.isMinLength(1)),
  /** The name of the Error a script's `await` throws; `ToolFailed` when
   *  absent. */
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  /** Brief summary for human-facing logs */
  summary: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Undefined),
  edits: Schema.optional(Schema.Undefined),
  files: Schema.optional(Schema.Undefined),
  ...ToolResultSharedFields,
});

/** The synthetic tool a run with an output schema submits its structured
 *  output through: its settled result's `value` is the run's output. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'submit_output';

export const ToolResultSchema = Schema.Union([
  ExecutedToolResultSchema,
  ErrorToolResultSchema,
]);
export type ToolResult = typeof ToolResultSchema.Type;

export class ToolError extends Error {
  /** Brief human-facing summary carried through to the ToolResult, when set. */
  readonly summary?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; summary?: string },
  ) {
    super(message, options);
    this.name = 'ToolError';
    this.summary = options?.summary;
  }
}

/** An attachment as its `tool.result` row holds it: its captured bytes by
 *  their session-store blob address (`blobAddress` of the base64), never
 *  inline, so the history a window or a resume reads carries no attachment
 *  bytes; a capture failure records the omission and its reason rather than
 *  a claim that bytes were included. */
export const SettledAttachmentSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  mimeType: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.String),
  content: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('stored'), digest: Sha256Schema }),
    Schema.Struct({
      kind: Schema.Literal('metadata-only'),
      reason: Schema.String.check(Schema.isMinLength(1)),
    }),
  ]),
});

/**
 * The follow-up builder's input. Derived from the exported members, never
 * re-declared: `files` loses its binary payload and `diagnostics` is narrowed
 * from `z.unknown()` to JSON, because an arbitrary value in a durable payload
 * is a `JSON.stringify` throw waiting for a cycle or a BigInt.
 *
 * `SettledFileSchema` is derived from `ToolFileAttachmentSchema`, NOT rebuilt
 * as a `strictObject`: its base `FileReferenceSchema` is a `z.looseObject`
 * and real attachments carry `base64Data`/`bytes` plus whatever extra keys a
 * tool attached, so a strict rebuild would refuse every executed result that
 * has an attachment. That same looseness is why the two binary fields go
 * through a transform rather than `.omit()`: on a loose object an omitted key
 * is only undeclared, so `base64Data` and the `Uint8Array` in `bytes` would
 * pass through as unknown keys and land in the row anyway. What the transform
 * leaves is then validated as JSON, exactly as `diagnostics` is: the loose
 * keys a tool attached are `unknown`, and a third byte buffer or a cyclic
 * object among them is the same `JSON.stringify` throw, on a row that is
 * already committed. The check runs after the transform rather than as a
 * `.pipe`, so the accepted input stays the real attachment a tool produced.
 */
const SettledFileMetadataSchema = ToolFileAttachmentSchema.mapFields(
  Struct.omit(['base64Data', 'bytes']),
); /* TODO(effect-schema): catchall; was `.catchall(JsonValueSchema)` */
const SettledFileSchema = ToolFileAttachmentSchema.transform(
  ({ base64Data: _base64Data, bytes: _bytes, ...file }) => file,
).superRefine((file, ctx) => {
  const metadata = Schema.decodeUnknownResult(SettledFileMetadataSchema)(file);
  if (Result.isSuccess(metadata)) return;
  for (const issue of metadata.failure.issues) ctx.addIssue({ ...issue });
});
export const SettledToolResultSchema = Schema.Union([
  ExecutedToolResultSchema.mapFields(
    Struct.omit(['files', 'consumedFollowUps', 'facts']),
  ).mapFields(
    Struct.assign({
      files: Schema.optional(Schema.Array(SettledFileSchema)),
      diagnostics: Schema.optional(JsonValueSchema),
    }),
  ),

  ErrorToolResultSchema.mapFields(
    Struct.assign({ diagnostics: Schema.optional(JsonValueSchema) }),
  ),
]);
