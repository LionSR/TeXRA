// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import { LineChangesSchema, LineCountSchema } from './lineChanges';

// Type imports
import type { ZodIssue } from 'zod';

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
export const ToolFileAttachmentSchema = FileReferenceSchema.extend({
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

const EditedFileRecordSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  source: z.string(),
  sourceDisplay: z.string(),
});

/**
 * Schema for flattened edit records used in state snapshots.
 * Unlike EditRecordSchema (which nests lineChanges), this schema flattens
 * added/removed directly on the object for simpler serialization.
 *
 * Used by: FileInteractionStateSnapshotSchema in AgentWorkspaceState.ts
 */
export const FlattenedEditRecordSchema = z.object({
  path: z.string(),
  added: LineCountSchema.prefault(0),
  removed: LineCountSchema.prefault(0),
});

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
export interface FormattedZodIssue {
  path: string;
  message: string;
  expected?: unknown;
  received?: unknown;
  code?: string;
}

/**
 * Structured validation error diagnostics.
 * Used to provide rich error information to models for self-correction.
 */
export interface ValidationErrorDiagnostics {
  type: typeof DIAGNOSTIC_TYPE_VALIDATION_ERROR;
  issues: ZodIssue[];
  formatted: FormattedZodIssue[];
}

/**
 * Format Zod issues into structured diagnostics for model consumption.
 * `expected`/`received` only exist on certain ZodIssue subtypes (e.g.
 * invalid_type), so we cast to access them.
 */
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
  /** Additional diagnostic information */
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
  /** Files edited during tool execution (for logging/tracking) */
  editedFiles: z.array(EditedFileRecordSchema).optional(),
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
  editedFiles: z.undefined().optional(),
  ...ToolResultSharedFields,
});

export const ToolResultSchema = z.discriminatedUnion('status', [
  ExecutedToolResultSchema,
  ErrorToolResultSchema,
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export class ToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolError';
  }
}
