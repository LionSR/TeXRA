// Third-party imports
import { z } from 'zod';

// Type imports
import type { ZodIssue } from 'zod';

// ============================================================================
// Zod Schemas - Single Source of Truth
// ============================================================================

/**
 * Schema for line change statistics.
 * Single source of truth - used by ToolResult, edits, and model handlers.
 */
const LineCountSchema = z.int().nonnegative();

export const LineChangesSchema = z.object({
  added: LineCountSchema,
  removed: LineCountSchema,
});
export type LineChanges = z.infer<typeof LineChangesSchema>;

/**
 * Base schema for file references (metadata only, no binary data).
 * Used when binary data has been stripped for serialization/logging.
 */
export const FileReferenceSchema = z.object({
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
export const EditRecordSchema = z.object({
  path: z.string(),
  lineChanges: LineChangesSchema.optional(),
  /** 1-based line number where the edit starts (for navigation) */
  startLine: z.int().positive().optional(),
});
export type EditRecord = z.infer<typeof EditRecordSchema>;

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
export type FlattenedEditRecord = z.infer<typeof FlattenedEditRecordSchema>;

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

/** Format Zod issues as a human-readable error message for ToolResult.error. */
export function formatZodIssuesAsMessage(issues: ZodIssue[]): string {
  const lines = issues.map((i) =>
    i.path.length ? `- ${i.path.join('.')}: ${i.message}` : `- ${i.message}`,
  );
  return `Invalid input:\n${lines.join('\n')}`;
}

export interface DiagnosticsPayload {
  path: string;
  command: 'list' | 'count';
  severity: Record<string, number>;
  /** Diagnostic messages from the linter (platform-specific type at runtime). */
  messages?: unknown[];
}

/**
 * Union type for diagnostic information attached to tool results.
 * - ZodIssue[]: Validation errors from schema parsing
 * - Error-like: Regular errors with name and optional stack
 * - DiagnosticsPayload: Structured diagnostics from tools
 * - unknown: Other diagnostic formats for forward compatibility
 */
export type ErrorDiagnostics =
  | ZodIssue[]
  | { name: string; stack?: string }
  | DiagnosticsPayload
  | unknown;

// ============================================================================
// ToolResult Schema
// ============================================================================

/**
 * Schema for tool execution results.
 * Uses looseObject to allow additional properties for forward compatibility.
 */
export const ToolResultSchema = z.looseObject({
  /** Detailed output from the tool */
  output: z.string().optional(),
  /** Brief summary of the tool execution result */
  summary: z.string().optional(),
  /** Error message if tool execution failed */
  error: z.string().optional(),
  /** User instruction that was processed */
  userInstruction: z.string().optional(),
  /** User-provided patch content */
  userPatch: z.string().optional(),
  /** Statistics about line changes made */
  lineChanges: LineChangesSchema.optional(),
  /** Records of edits made during tool execution */
  edits: z.array(EditRecordSchema).optional(),
  /** Whether this result represents an error */
  isError: z.boolean().optional(),
  /** Additional diagnostic information */
  diagnostics: z.unknown().optional(),
  /** File attachments (may contain binary data) */
  files: z.array(ToolFileAttachmentSchema).optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export class ToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolError';
  }
}
