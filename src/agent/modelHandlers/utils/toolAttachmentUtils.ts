// Local imports - tools
import type { ToolFileAttachment, ToolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

export const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

export interface ExtractedToolAttachments {
  attachments: ToolFileAttachment[];
  sanitizedResult: Record<string, unknown>;
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

export function extractToolAttachments(
  result: Record<string, unknown>,
): ExtractedToolAttachments {
  const attachmentsCandidate = (result as { files?: unknown }).files;
  const attachments: ToolFileAttachment[] = Array.isArray(attachmentsCandidate)
    ? attachmentsCandidate.filter(isToolFileAttachment)
    : [];

  const sanitizedResult: Record<string, unknown> = { ...result };
  if (attachments.length > 0) {
    sanitizedResult.files = attachments.map(
      ({ base64Data, bytes, ...rest }) => ({
        ...rest,
      }),
    );
  } else if ('files' in sanitizedResult) {
    delete sanitizedResult.files;
  }

  if ('base64Image' in sanitizedResult) {
    delete sanitizedResult.base64Image;
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

export function sanitizeToolResultForLog(
  result: ToolResult,
): Record<string, unknown> {
  const baseCopy: Record<string, unknown> = { ...result };
  const { sanitizedResult } = extractToolAttachments(baseCopy);
  const sanitized: Record<string, unknown> = { ...sanitizedResult };

  if (typeof result.base64Image === 'string') {
    sanitized.base64Image = `[omitted ${result.base64Image.length} chars]`;
  }

  return sanitized;
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
