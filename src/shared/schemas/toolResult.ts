import { z, type ZodIssue } from 'zod';

import { LineChangesSchema } from './lineChanges';

/**
 * Base schema for file references (metadata only, no binary data).
 * Used when binary data has been stripped for serialization/logging.
 */
const FileReferenceSchema = z.looseObject({
  /** Workspace-relative or descriptive path for the file */
  path: z.string(),
  /** MIME type for the file */
  mimeType: z.string(),
  /** Optional human readable description */
  description: z.string().optional(),
});
export type FileReference = z.infer<typeof FileReferenceSchema>;

/**
 * Schema for file attachments with optional binary data.
 * Extends FileReferenceSchema with binary payload fields.
 */
const ToolFileAttachmentSchema = FileReferenceSchema.extend({
  /** Base64 encoded payload when inline transport is supported */
  base64Data: z.string().optional(),
  /** Raw bytes for providers that require binary uploads */
  bytes: z.instanceof(Uint8Array).optional(),
});
export type ToolFileAttachment = z.infer<typeof ToolFileAttachmentSchema>;

/**
 * Schema for edit records in tool results.
 */
const EditRecordSchema = z.object({
  path: z.string(),
  lineChanges: LineChangesSchema.optional(),
  /** 1-based line number where the edit starts (for navigation) */
  startLine: z.int().positive().optional(),
});
export type EditRecord = z.infer<typeof EditRecordSchema>;

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
 * Provides structured information that helps models self-correct.
 */
const FormattedZodIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  expected: z.unknown().optional(),
  received: z.unknown().optional(),
  code: z.string().optional(),
});
export type FormattedZodIssue = z.infer<typeof FormattedZodIssueSchema>;

/**
 * Structured validation error diagnostics. One of several shapes a tool's
 * `ToolResult.diagnostics` may carry (see that field's own comment) — this is
 * the one produced for Zod input-validation failures, used to provide rich
 * error information to models for self-correction. `issues` stays
 * `z.custom<ZodIssue>()` since `ZodIssue` is Zod's own internal type with no
 * exported schema to compose against.
 */
export const ValidationErrorDiagnosticsSchema = z.object({
  type: z.literal(DIAGNOSTIC_TYPE_VALIDATION_ERROR),
  issues: z.array(z.custom<ZodIssue>()),
  formatted: z.array(FormattedZodIssueSchema),
});
export type ValidationErrorDiagnostics = z.infer<
  typeof ValidationErrorDiagnosticsSchema
>;

/**
 * Format Zod issues into structured diagnostics for model consumption.
 * `expected`/`received` only exist on certain ZodIssue subtypes (e.g.
 * invalid_type), so we cast to access them.
 */
/**
 * Render Zod issues as a single `; `-joined, human-readable string
 * (`path.to.field: message; <root>: message`). Shared by the salvage parsers
 * that must loudly surface malformed persisted entries (roundIndexed,
 * streamData, StreamSnapshotStore) without coupling them to the structured
 * {@link formatZodIssuesForDiagnostics} output. Keeps the `<root>` fallback
 * and `; ` separator defined once.
 */
export function formatZodIssuesMessage(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function formatZodIssuesForDiagnostics(
  issues: ZodIssue[],
): FormattedZodIssue[] {
  return issues.map((issue) => {
    const extendedIssue = issue as ZodIssue & {
      expected?: unknown;
      received?: unknown;
    };
    return {
      path: issue.path.join('.'),
      message: issue.message,
      expected: extendedIssue.expected,
      received: extendedIssue.received,
      code: issue.code,
    };
  });
}

// ============================================================================
// ToolResult Schema
// ============================================================================

/**
 * Schema for tool execution results.
 * Every field a tool wants surfaced to the model must be declared below —
 * there is no catchall, so an undeclared field is silently stripped rather
 * than reaching `formatToolResultAsText`.
 */
const ToolResultSharedFields = {
  /** User instruction that was processed */
  userInstruction: z.string().optional(),
  /** User-provided patch content */
  userPatch: z.string().optional(),
  /**
   * Additional diagnostic information. Deliberately `z.unknown()`: every tool
   * shapes its own payload here (validation issues, severity counts, an
   * unread-file reason, an error name, …), so there is no single schema to
   * validate against. Consumers that care about one specific shape — e.g.
   * {@link ValidationErrorDiagnosticsSchema} — parse it themselves.
   */
  diagnostics: z.unknown().optional(),
  /** Summary added by handlers when attachments are available */
  attachmentSummary: z.string().optional(),
};

const ExecutedToolResultSchema = z.object({
  status: z.literal('executed'),
  /** Detailed output from the tool */
  output: z.string().optional(),
  /** Brief summary of the tool execution result */
  summary: z.string().optional(),
  /** End the current model turn after this successful tool result is paired. */
  endTurn: z.boolean().optional(),
  error: z.undefined().optional(),
  /** Statistics about line changes made */
  lineChanges: LineChangesSchema.optional(),
  /** Records of edits made during tool execution */
  edits: z.array(EditRecordSchema).optional(),
  /** File attachments (may contain binary data) */
  files: z.array(ToolFileAttachmentSchema).optional(),
  ...ToolResultSharedFields,
});

const ErrorToolResultSchema = z.object({
  status: z.literal('error'),
  /** Error message if tool execution failed */
  error: z.string().min(1),
  /** Brief summary for human-facing logs */
  summary: z.string().optional(),
  output: z.undefined().optional(),
  lineChanges: z.undefined().optional(),
  edits: z.undefined().optional(),
  files: z.undefined().optional(),
  ...ToolResultSharedFields,
});

export const ToolResultSchema = z.discriminatedUnion('status', [
  ExecutedToolResultSchema,
  ErrorToolResultSchema,
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

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
