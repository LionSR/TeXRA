// Third-party imports
import { z } from 'zod';

// Type imports
import type { Diagnostic } from 'vscode';
import type { ZodIssue } from 'zod';

// ============================================================================
// Zod Schemas - Single Source of Truth
// ============================================================================

/**
 * Schema for line change statistics.
 * Single source of truth - used by ToolResult, edits, and model handlers.
 */
export const LineChangesSchema = z.object({
  added: z.number(),
  removed: z.number(),
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
  bytes: z.custom<Uint8Array>((val) => val instanceof Uint8Array).optional(),
});
export type ToolFileAttachment = z.infer<typeof ToolFileAttachmentSchema>;

/**
 * Schema for edit records in tool results.
 */
export const EditRecordSchema = z.object({
  path: z.string(),
  lineChanges: LineChangesSchema.optional(),
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
  added: z.number().prefault(0),
  removed: z.number().prefault(0),
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

export interface DiagnosticsPayload {
  path: string;
  command: 'list' | 'count';
  severity: Record<string, number>;
  messages?: Diagnostic[];
}

// Define proper type for diagnostic information
export type ErrorDiagnostics =
  | ZodIssue[] // For validation errors
  | { name: string; stack?: string } // For regular errors
  | DiagnosticsPayload // For diagnostics payloads returned by tools
  | unknown; // For other types of diagnostics

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
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
