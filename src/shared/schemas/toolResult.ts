// Third-party imports
import { z } from 'zod';

// Local imports - utils
import { isNonEmptyString } from '@utils/core';

// Local imports - shared schemas
import { LineChangesSchema, LineCountSchema } from './lineChanges';

// Type imports
import type { ZodIssue } from 'zod';

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

// ============================================================================
// ToolResult Normalization (status inference for ambiguous legacy results)
// ============================================================================

/**
 * Tool result status discriminant. `executed` results carry output/summary/
 * files etc.; `error` results carry a required non-empty `error` message.
 */
export const TOOL_RESULT_STATUSES = ['executed', 'error'] as const;
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

/**
 * Normalizes an ambiguous `ToolResultSchema` shape (no reliable `status`
 * field; only `output`/`summary`/`error`/`isError` populated ad hoc by tool
 * implementations) into a `{ status, ... }` shape that can be narrowed on
 * `status` directly.
 *
 * The computed discriminator always wins over any incidental raw `status`
 * key a result object might carry (no current tool implementation sets one,
 * but this keeps behavior unambiguous rather than trusting an unverified
 * field) — precedence rules are the single source of truth now, previously
 * duplicated as a heuristic inline in `toolAttachmentUtils.ts`: an explicit
 * `isError: true`, or non-empty `error` text with no `output`, wins as
 * `'error'`; otherwise the result is `'executed'`. When `'error'`, the
 * surfaced error text prefers `error`, then `output`, then `summary`, then a
 * generic fallback — this preserves historical behavior for tools that only
 * ever set `output`/`summary` while failing.
 */
export const NormalizedToolResultSchema = ToolResultSchema.transform(
  (raw) => {
    const hasError = isNonEmptyString(raw.error);
    const hasOutput = isNonEmptyString(raw.output);
    const hasSummary = isNonEmptyString(raw.summary);
    const isError = raw.isError === true;
    const status: ToolResultStatus =
      isError || (hasError && !hasOutput) ? 'error' : 'executed';

    if (status !== 'error') {
      return { ...raw, status };
    }

    let errorText: string;
    if (isNonEmptyString(raw.error)) errorText = raw.error;
    else if (isNonEmptyString(raw.output)) errorText = raw.output;
    else if (isNonEmptyString(raw.summary)) errorText = raw.summary;
    else errorText = 'Tool failed';

    return { ...raw, status, error: errorText };
  },
);

export class ToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolError';
  }
}
