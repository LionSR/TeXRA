// Local imports - tool result schemas
import {
  type FileReference,
  type ToolFileAttachment,
  type ToolResult,
  ToolResultSchema,
  ValidationErrorDiagnosticsSchema,
} from '@shared/schemas';

/**
 * Sanitize the shared `diagnostics` field. Sanitized results only carry the
 * validation-error diagnostics shape (see `ToolResultSharedFields.diagnostics`
 * for why the source field is `z.unknown()`); any other tool's diagnostics
 * payload — or a validation-error payload whose `formatted` doesn't actually
 * match `FormattedZodIssueSchema` — is dropped rather than passed through
 * untyped.
 */
function sanitizeDiagnostics(
  diagnostics: unknown,
): { type: 'validation_error'; formatted: unknown } | undefined {
  if (diagnostics === undefined) return undefined;
  const validationError =
    ValidationErrorDiagnosticsSchema.safeParse(diagnostics);
  if (!validationError.success) return undefined;
  const { type, formatted } = validationError.data;
  return { type, formatted };
}

/**
 * Result from extracting attachments from a tool result.
 * Simple interface - no runtime validation needed for this structure.
 */
export interface ExtractedToolAttachments {
  /** Extracted file attachments with binary data. */
  attachments: ToolFileAttachment[];
  /** Sanitized result payload without binary data. */
  sanitizedResult: ToolResult;
}

/**
 * Extracts file attachments from a tool result and returns a typed payload.
 * Binary data (base64Data, bytes) is stripped from the result.
 *
 * Uses the source-level `ToolResultSchema` discriminator; tools declare
 * success vs error before this projection sees the result.
 *
 * @param result - Raw tool result, possibly containing binary data.
 * @returns Extracted attachments and typed payload without binary data.
 */
export function extractToolAttachments(
  result: ToolResult,
): ExtractedToolAttachments {
  const parsed = ToolResultSchema.parse(result);
  const diagnostics = sanitizeDiagnostics(parsed.diagnostics);

  if (parsed.status === 'error') {
    // Error variant: no binary-bearing fields exist on this branch of the
    // schema (output/edits/files are all `z.undefined()` here), so there is
    // nothing to strip beyond binary payloads that can't occur. `summary` is
    // real on this variant — "Brief summary for human-facing logs" — and must
    // survive sanitization; it feeds ToolUseDispatchNode's progress log.
    const sanitizedResult: ToolResult = {
      status: 'error',
      error: parsed.error,
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      ...(parsed.userInstruction !== undefined
        ? { userInstruction: parsed.userInstruction }
        : {}),
      ...(parsed.userPatch !== undefined
        ? { userPatch: parsed.userPatch }
        : {}),
      ...(parsed.attachmentSummary !== undefined
        ? { attachmentSummary: parsed.attachmentSummary }
        : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    };
    return { attachments: [], sanitizedResult };
  }

  // Executed variant: strip binary data (base64Data/bytes) from files, keep
  // everything else the schema declares.
  const attachments: ToolFileAttachment[] = parsed.files ?? [];
  const sanitizedFiles: FileReference[] | undefined =
    attachments.length > 0
      ? attachments.map((file): FileReference => ({
          path: file.path,
          mimeType: file.mimeType,
          ...(file.description ? { description: file.description } : {}),
        }))
      : undefined;

  const sanitizedResult: ToolResult = {
    status: 'executed',
    ...(parsed.output !== undefined ? { output: parsed.output } : {}),
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    ...(parsed.endTurn !== undefined ? { endTurn: parsed.endTurn } : {}),
    ...(parsed.edits !== undefined ? { edits: parsed.edits } : {}),
    ...(sanitizedFiles !== undefined ? { files: sanitizedFiles } : {}),
    ...(parsed.userInstruction !== undefined
      ? { userInstruction: parsed.userInstruction }
      : {}),
    ...(parsed.userPatch !== undefined ? { userPatch: parsed.userPatch } : {}),
    ...(parsed.attachmentSummary !== undefined
      ? { attachmentSummary: parsed.attachmentSummary }
      : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };

  return { attachments, sanitizedResult };
}
