// Local imports - tools
import type {
  ToolFileAttachment,
  ToolResult,
  ErrorDiagnostics,
} from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

export const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

/**
 * File reference in a tool result payload (binary data stripped).
 */
export interface FileReference {
  path: string;
  mimeType: string;
  description?: string;
}

/**
 * Record of a file edited during tool execution.
 */
export interface EditedFileRecord {
  path: string;
  ok: boolean;
  source: string;
  sourceDisplay: string;
}

/**
 * Strongly-typed payload for tool results sent to model handlers.
 * This is what gets passed to handlers - no binary data, properly typed fields.
 */
export interface ToolResultPayload {
  summary?: string;
  output?: string;
  error?: string;
  userInstruction?: string;
  userPatch?: string;
  isError?: boolean;
  lineChanges?: { added: number; removed: number };
  diagnostics?: ErrorDiagnostics;
  edits?: Array<{
    path: string;
    lineChanges?: { added: number; removed: number };
  }>;
  /** File references (binary data stripped) */
  files?: FileReference[];
  /** Files edited during tool execution (for logging/tracking) */
  editedFiles?: EditedFileRecord[];
  /** Summary added by handlers when attachments are available */
  attachmentSummary?: string;
  /** Allow additional properties for forward compatibility */
  [key: string]: unknown;
}

export interface ExtractedToolAttachments {
  attachments: ToolFileAttachment[];
  sanitizedResult: ToolResultPayload;
}

function isToolFileAttachment(value: unknown): value is ToolFileAttachment {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.mimeType === 'string' &&
    candidate.mimeType.length > 0
  );
}

/**
 * Extracts file attachments from a tool result and returns a typed payload.
 * Binary data (base64Data, bytes, base64Image) is stripped from the result.
 *
 * @param result - Raw tool result (may contain binary data)
 * @returns Extracted attachments and typed payload (without binary data)
 */
export function extractToolAttachments(
  result: ToolResult | ToolResultPayload | Record<string, unknown>,
): ExtractedToolAttachments {
  const attachmentsCandidate = (result as { files?: unknown }).files;
  const attachments: ToolFileAttachment[] = Array.isArray(attachmentsCandidate)
    ? attachmentsCandidate.filter(isToolFileAttachment)
    : [];

  // Build result payload with proper typing
  const sanitizedResult: ToolResultPayload = {};

  // Copy all defined properties except binary data
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue;
    // Skip binary fields
    if (key === 'base64Image' || key === 'base64Data' || key === 'bytes') {
      continue;
    }
    sanitizedResult[key] = value;
  }

  // Strip binary data from file references, keep metadata
  if (attachments.length > 0) {
    sanitizedResult.files = attachments.map(
      ({ base64Data, bytes, ...rest }): FileReference => ({
        path: rest.path,
        mimeType: rest.mimeType,
        ...(rest.description ? { description: rest.description } : {}),
      }),
    );
  } else {
    // Remove files key if no valid attachments
    delete sanitizedResult.files;
  }

  return { attachments, sanitizedResult };
}

export function describeAttachments(
  attachments: ToolFileAttachment[],
): string[] {
  return attachments.map((file) => {
    const path =
      typeof file.path === 'string' && file.path.length > 0
        ? file.path
        : 'attachment';
    const type =
      typeof file.mimeType === 'string' && file.mimeType.length > 0
        ? file.mimeType
        : DEFAULT_ATTACHMENT_MIME_TYPE;
    return `- ${path} (${type})`;
  });
}

/**
 * Creates a log-safe payload from a tool result, omitting binary data and noting its presence.
 */
export function sanitizeToolResultForLog(
  result: ToolResult,
): ToolResultPayload {
  const { sanitizedResult } = extractToolAttachments(result);

  // Note presence of base64Image without including the data
  if (typeof result.base64Image === 'string') {
    sanitizedResult.base64Image = `[omitted ${result.base64Image.length} chars]`;
  }

  return sanitizedResult;
}

export async function loadAttachmentBuffer(
  attachment: ToolFileAttachment,
): Promise<Buffer> {
  if (attachment.bytes && attachment.bytes.length > 0) {
    return Buffer.from(attachment.bytes);
  }

  if (attachment.base64Data && attachment.base64Data.length > 0) {
    return Buffer.from(attachment.base64Data, 'base64');
  }

  if (attachment.path && attachment.path.length > 0) {
    return WorkspaceFS.readFileBytes(attachment.path);
  }

  throw new Error('Attachment did not include bytes, base64 data, or a path.');
}
