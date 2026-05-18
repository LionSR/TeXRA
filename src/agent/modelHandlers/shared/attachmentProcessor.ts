// Standard library imports
import { basename } from 'node:path';

// Local imports - agent
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - common
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';

// Local file imports
import {
  loadAttachmentBuffer,
  type ToolFileAttachment,
} from '../utils/toolAttachmentUtils';

/** MIME types accepted as inline file content by the OpenAI Responses API. */
export const INLINEABLE_FILE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
]);

/** Image media types supported across providers (Anthropic + OpenAI). */
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export type AttachmentClassification =
  | 'image'
  | 'pdf'
  | 'document'
  | 'unsupported';

/**
 * Classifies a tool file attachment by MIME type.
 */
export function classifyAttachment(attachment: ToolFileAttachment): {
  classification: AttachmentClassification;
  normalizedMime: string;
} {
  const mimeType = attachment.mimeType ?? 'application/octet-stream';
  const normalized = mimeType.toLowerCase();

  if (SUPPORTED_IMAGE_MEDIA_TYPES.has(normalized)) {
    return { classification: 'image', normalizedMime: normalized };
  }
  if (normalized === 'application/pdf') {
    return { classification: 'pdf', normalizedMime: normalized };
  }
  return { classification: 'unsupported', normalizedMime: normalized };
}

export interface LoadedAttachment {
  attachment: ToolFileAttachment;
  buffer: Buffer;
  base64Data: string;
  classification: AttachmentClassification;
  normalizedMime: string;
  filename: string;
}

/**
 * Loads and classifies an attachment, returning its buffer and metadata.
 * Returns null for unsupported types or read failures.
 */
export async function loadClassifiedAttachment(
  attachment: ToolFileAttachment,
  logger: AgentLogger,
): Promise<LoadedAttachment | null> {
  const { classification, normalizedMime } = classifyAttachment(attachment);
  if (classification === 'unsupported') {
    return null;
  }

  let buffer: Buffer | undefined;
  try {
    buffer = await loadAttachmentBuffer(attachment);
  } catch (err) {
    logger.warn(
      `Unable to read attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
    );
    return null;
  }

  const filename =
    typeof attachment.path === 'string' && attachment.path.length > 0
      ? basename(attachment.path)
      : classification === 'pdf'
        ? 'document.pdf'
        : `image.${normalizedMime.split('/').pop() ?? 'png'}`;

  const base64Data = buffer.toString('base64');

  return {
    attachment,
    buffer,
    base64Data,
    classification,
    normalizedMime,
    filename,
  };
}

/**
 * Sanitizes a filename for provider file upload APIs.
 * Strips path separators, control chars, and forbidden characters.
 */
export function sanitizeUploadFilename(filename: string): string {
  const baseName = basename(filename) || filename;
  const trimmed = baseName.trim();
  const withoutControlChars = Array.from(trimmed, (char) =>
    char.charCodeAt(0) < 32 ? '_' : char,
  ).join('');
  const withoutForbidden = withoutControlChars.replaceAll(/[:<>"|?*\\/]/g, '_');
  const sanitized = withoutForbidden || 'attachment';
  return sanitized.slice(0, 255);
}
