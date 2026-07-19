import { Buffer } from 'node:buffer';

// Third-party imports
import { toFile } from '@anthropic-ai/sdk';

// Local imports - common
import type { AgentTrace } from '@agent/trace';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';

// Type imports - agent and tools
import { extractMimeSubtype } from '@utils/text/stringUtils';

// Local imports - model handlers
import { FILES_API_BETA } from './anthropicContextManagement';
import {
  countPdfPagesFromBuffer,
  sanitizeAnthropicFilename,
} from './anthropicDocumentHandling';
import { loadAttachmentBuffer, wipeBuffer } from '../utils/toolAttachmentUtils';
import { reportMediaAttachmentFailure } from '../support/mediaAttachmentPolicy';

// Type imports - Anthropic SDK
import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages';
import type { Anthropic } from '@anthropic-ai/sdk';

/** Supported image media types from SDK's Base64ImageSource definition */
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageMediaType(
  mediaType: string,
): mediaType is Base64ImageSource['media_type'] {
  return SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType);
}

export interface UploadedAnthropicAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  blockType: 'image' | 'document';
  base64Data?: string;
  mediaType?: string;
}

interface UploadToolAttachmentsResult {
  uploaded: UploadedAnthropicAttachment[];
  unsupported: ToolFileAttachment[];
  pageLimitExceeded: ToolFileAttachment[];
}

/**
 * Uploads tool file attachments (images and PDFs) to the Anthropic Files API.
 */
export async function uploadToolAttachments(
  client: Anthropic,
  attachments: ToolFileAttachment[],
  logger: AgentTrace,
  uploadedPdfPageCounts: Map<string, number>,
  maxPdfPages: number,
): Promise<UploadToolAttachmentsResult> {
  const uploaded: UploadedAnthropicAttachment[] = [];
  const unsupported: ToolFileAttachment[] = [];
  const pageLimitExceeded: ToolFileAttachment[] = [];

  const trackedPdfPageCount = (): number => {
    let total = 0;
    for (const count of uploadedPdfPageCounts.values()) total += count;
    return total;
  };

  for (const attachment of attachments) {
    const mimeType = attachment.mimeType ?? 'application/octet-stream';
    const normalized = mimeType.toLowerCase();
    const imageType = isSupportedImageMediaType(normalized);
    const isPdf = normalized === 'application/pdf';

    if (!imageType && !isPdf) {
      unsupported.push(attachment);
      continue;
    }

    let buffer: Buffer | undefined;
    try {
      buffer = await loadAttachmentBuffer(attachment);
    } catch (err) {
      reportMediaAttachmentFailure(
        logger,
        'toolAttachment',
        err,
        `unable to read ${attachment.path ?? 'attachment'}`,
      );
      unsupported.push(attachment);
      continue;
    }

    // Check PDF page limit before uploading
    let pdfPageCount = 0;
    if (isPdf) {
      pdfPageCount = await countPdfPagesFromBuffer(buffer);
      if (trackedPdfPageCount() + pdfPageCount > maxPdfPages) {
        pageLimitExceeded.push(attachment);
        buffer = wipeBuffer(buffer);
        continue;
      }
    }

    try {
      const filename = sanitizeAnthropicFilename(
        attachment.path ??
          (isPdf
            ? 'document.pdf'
            : `image.${extractMimeSubtype(normalized, 'png')}`),
      );

      const base64Data = buffer.toString('base64');
      const uploadedFile = await client.beta.files.upload({
        file: await toFile(buffer, filename, { type: mimeType }),
        betas: [FILES_API_BETA],
      });

      if (isPdf && pdfPageCount > 0) {
        uploadedPdfPageCounts.set(uploadedFile.id, pdfPageCount);
      }

      uploaded.push({
        attachment,
        fileId: uploadedFile.id,
        blockType: isPdf ? 'document' : 'image',
        base64Data,
        mediaType: normalized,
      });
    } catch (err) {
      // Upload failed — degrade to unsupported, but report so a dropped
      // attachment isn't silently omitted from the request.
      reportMediaAttachmentFailure(
        logger,
        'toolAttachment',
        err,
        `failed to upload ${attachment.path ?? 'attachment'}`,
      );
      unsupported.push(attachment);
    } finally {
      buffer = wipeBuffer(buffer);
    }
  }

  return { uploaded, unsupported, pageLimitExceeded };
}
