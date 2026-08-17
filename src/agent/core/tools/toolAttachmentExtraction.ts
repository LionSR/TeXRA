// Local imports - tool result schemas
import {
  type FileReference,
  type ToolFileAttachment,
  type ToolResult,
  ToolResultSchema,
  ValidationErrorDiagnosticsSchema,
} from '@shared/schemas';

const ERROR_PAYLOAD_STRIPPED_KEYS = new Set([
  'output',
  'summary',
  'lineChanges',
  'edits',
  'files',
]);

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
  const status = parsed.status;
  const attachments: ToolFileAttachment[] =
    status === 'executed' ? (parsed.files ?? []) : [];
  const sanitizedResult: Record<string, unknown> = { status };

  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (key === 'base64Data' || key === 'bytes') {
      continue;
    }
    if (status === 'executed' && key === 'error') {
      continue;
    }
    if (status === 'error' && ERROR_PAYLOAD_STRIPPED_KEYS.has(key)) {
      continue;
    }
    if (key === 'diagnostics') {
      // Sanitized results only carry the validation-error diagnostics shape
      // (see ToolResultSharedFields.diagnostics); any other tool's
      // diagnostics payload — or a validation-error payload whose `formatted`
      // doesn't actually match FormattedZodIssueSchema — is dropped here
      // rather than passed through untyped.
      const validationError = ValidationErrorDiagnosticsSchema.safeParse(value);
      if (validationError.success) {
        const { type, formatted } = validationError.data;
        sanitizedResult[key] = { type, formatted };
      }
      continue;
    }
    sanitizedResult[key] = value;
  }

  if (status === 'executed' && attachments.length > 0) {
    sanitizedResult.files = attachments.map((file): FileReference => ({
      path: file.path,
      mimeType: file.mimeType,
      ...(file.description ? { description: file.description } : {}),
    }));
  } else {
    delete sanitizedResult.files;
  }

  return {
    attachments,
    sanitizedResult: sanitizedResult as ToolResult,
  };
}
