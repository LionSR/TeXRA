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
  // The parse IS the field whitelist: `ToolResultSchema` has no catchall, so
  // every undeclared key is already stripped here. Re-listing the declared
  // fields by hand would only add a place for a newly declared field to be
  // silently dropped.
  const { files, diagnostics: rawDiagnostics, ...rest } = ToolResultSchema.parse(
    result,
  );
  const diagnostics = sanitizeDiagnostics(rawDiagnostics);
  const attachments: ToolFileAttachment[] = files ?? [];

  const sanitizedResult = {
    ...rest,
    // Binary payloads (base64Data/bytes) are the one thing the schema keeps
    // and this projection must not: `FileReferenceSchema` is a loose object.
    ...(attachments.length > 0
      ? {
          files: attachments.map(
            (file): FileReference => ({
              path: file.path,
              mimeType: file.mimeType,
              ...(file.description ? { description: file.description } : {}),
            }),
          ),
        }
      : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  } as ToolResult;

  return { attachments, sanitizedResult };
}
