import { Schema, SchemaGetter, SchemaIssue, Struct } from 'effect';

import { JsonValueSchema } from './jsonValue';
import { LineChangesSchema } from './lineChanges';
import { Sha256Schema } from './offeredTools';

/**
 * Base schema for file references (metadata only, no binary data).
 * Used when binary data has been stripped for serialization/logging.
 */
const FileReferenceFieldsSchema = Schema.Struct({
  /** Workspace-relative or descriptive path for the file */
  path: Schema.String,
  /** MIME type for the file */
  mimeType: Schema.String,
  /** Optional human readable description */
  description: Schema.optional(Schema.String),
});
/** Whatever else a tool attached rides along as unknown keys. */
const anyExtraKeys = [Schema.Record(Schema.String, Schema.Unknown)] as const;
const FileReferenceSchema = Schema.StructWithRest(
  FileReferenceFieldsSchema,
  anyExtraKeys,
);
/**
 * A file a tool result names without its bytes: its path, MIME type and
 * description, plus whatever else the tool attached. The form a file reference
 * takes once binary data has been stripped for logging or transport.
 */
export type FileReference = typeof FileReferenceSchema.Type;

/**
 * Schema for file attachments with optional binary data.
 * Extends FileReferenceSchema with binary payload fields.
 */
const ToolFileAttachmentFieldsSchema = FileReferenceFieldsSchema.mapFields(
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
const ToolFileAttachmentSchema = Schema.StructWithRest(
  ToolFileAttachmentFieldsSchema,
  anyExtraKeys,
);
/**
 * A file a tool attaches to its result: a {@link FileReference} that may also
 * carry the bytes inline (base64 or raw) or name them by the digest the
 * session store already holds.
 */
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
/**
 * One file edit a tool result reports: the path, the added and removed line
 * counts, and the first edited line, so a host can open the file at the
 * change.
 */
export type EditRecord = typeof EditRecordSchema.Type;

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Diagnostic type identifier for tool parameter validation errors.
 * Used when a tool's input fails its schema.
 */
export const DIAGNOSTIC_TYPE_VALIDATION_ERROR = 'validation_error' as const;

/**
 * One schema issue formatted for model consumption: the dotted path of the
 * field and the issue's message. Every field is JSON by construction: the
 * settled tool result is stored as a JSON value, and a present-but-undefined
 * key there is a refused row, not a dropped key.
 */
const FormattedIssueSchema = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
type FormattedIssue = typeof FormattedIssueSchema.Type;

/**
 * Structured validation error diagnostics. One of several shapes a tool's
 * `ToolResult.diagnostics` may carry (see that field's own comment) — this is
 * the one produced for input-validation failures, used to provide rich
 * error information to models for self-correction.
 */
export const ValidationErrorDiagnosticsSchema = Schema.Struct({
  type: Schema.Literal(DIAGNOSTIC_TYPE_VALIDATION_ERROR),
  formatted: Schema.Array(FormattedIssueSchema),
});
/** The decoded shape of {@link ValidationErrorDiagnosticsSchema}. */
export type ValidationErrorDiagnostics =
  (typeof ValidationErrorDiagnosticsSchema)['Type'];

const flattenIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Flatten a schema failure's issue tree into one row per leaf issue, for
 * model consumption: the dotted path of the field and the message.
 */
export function formatIssuesForDiagnostics(
  error: Schema.SchemaError,
): FormattedIssue[] {
  return flattenIssue(error.issue).issues.map((leaf) => ({
    path: (leaf.path ?? [])
      .map((segment) =>
        String(typeof segment === 'object' ? segment.key : segment),
      )
      .join('.'),
    message: leaf.message,
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
   * Additional diagnostic information. Deliberately `Schema.Unknown`: every tool
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

/**
 * What a tool's `run` returns: an `executed` result with its output, summary,
 * edits, attachments, structured value and the facts it states, or an `error`
 * result with its message. Every tool produces one; the loop stores it as the
 * settled form and formats it for the model.
 */
export const ToolResultSchema = Schema.Union([
  ExecutedToolResultSchema,
  ErrorToolResultSchema,
]);
/** The decoded shape of {@link ToolResultSchema}. */
export type ToolResult = typeof ToolResultSchema.Type;

/**
 * The error a tool throws to fail its call with a message meant for the model,
 * and optionally a shorter summary for the transcript. The tool definition's
 * `run` wrapper turns it into an `error` {@link ToolResult}.
 */
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
 * from `Schema.Unknown` to JSON, because an arbitrary value in a durable
 * payload is a `JSON.stringify` throw waiting for a cycle or a BigInt.
 *
 * A settled file is the attachment a tool produced, decoded as such, with
 * `base64Data` and `bytes` dropped: real attachments carry them plus whatever
 * extra keys a tool attached, and those extra keys stay. What the drop leaves
 * is then validated as JSON, exactly as `diagnostics` is: a third byte buffer
 * or a cyclic object among the extra keys is the same `JSON.stringify` throw,
 * on a row that is already committed. Encoding is the identity: a settled
 * file is an attachment without its bytes.
 */
const SettledFileMetadataSchema = Schema.StructWithRest(
  ToolFileAttachmentFieldsSchema.mapFields(
    Struct.omit(['base64Data', 'bytes']),
  ),
  // `undefined` admitted beside JSON: the optional fields read
  // `string | undefined`, which an index signature must cover in the
  // published declarations, and `JSON.stringify` drops such a key.
  [
    Schema.Record(
      Schema.String,
      Schema.Union([JsonValueSchema, Schema.Undefined]),
    ),
  ],
);
const SettledFileSchema = ToolFileAttachmentSchema.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(
      ({ base64Data: _base64Data, bytes: _bytes, ...file }) => file,
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
  Schema.decodeTo(SettledFileMetadataSchema),
);
/**
 * A {@link ToolResultSchema} as a `tool.result` row stores it: attachments
 * keep their metadata and extra keys but lose their bytes, consumed follow-ups
 * and facts are committed as rows of their own, and `diagnostics` is narrowed
 * to JSON so the row always serializes.
 */
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
