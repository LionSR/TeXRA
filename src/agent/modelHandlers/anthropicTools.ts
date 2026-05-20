import { Buffer } from 'node:buffer';

// Third-party imports
import { toFile } from '@anthropic-ai/sdk';

// Local imports - common
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';

// Type imports - agent and tools
import type { AgentLogger } from '@logger/AgentLogger';
import type { ToolFileAttachment } from '@tools/result';

// Local imports - model handlers
import { FILES_API_BETA } from './anthropicContextManagement';
import {
  countPdfPagesFromBuffer,
  sanitizeAnthropicFilename,
} from './anthropicDocumentHandling';
import { loadAttachmentBuffer } from './utils/toolAttachmentUtils';

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

export const isSupportedImageMediaType = (
  mediaType: string,
): mediaType is Base64ImageSource['media_type'] =>
  SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType);

export interface UploadedAnthropicAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  blockType: 'image' | 'document';
  base64Data?: string;
  mediaType?: string;
}

export interface UploadToolAttachmentsResult {
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
  logger: AgentLogger,
  uploadedPdfPageCounts: Map<string, number>,
  getTrackedPdfPageCount: () => number,
  getMaxPdfPages: () => number,
): Promise<UploadToolAttachmentsResult> {
  const uploaded: UploadedAnthropicAttachment[] = [];
  const unsupported: ToolFileAttachment[] = [];
  const pageLimitExceeded: ToolFileAttachment[] = [];

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
      logger.warn(
        `Unable to read attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
      );
      unsupported.push(attachment);
      continue;
    }

    // Check PDF page limit before uploading
    let pdfPageCount = 0;
    if (isPdf) {
      pdfPageCount = await countPdfPagesFromBuffer(buffer);
      if (getTrackedPdfPageCount() + pdfPageCount > getMaxPdfPages()) {
        pageLimitExceeded.push(attachment);
        buffer.fill(0);
        buffer = undefined;
        continue;
      }
    }

    try {
      const filename = sanitizeAnthropicFilename(
        attachment.path ??
          (isPdf
            ? 'document.pdf'
            : `image.${normalized.split('/').pop() ?? 'png'}`),
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
    } catch {
      unsupported.push(attachment);
    } finally {
      if (buffer) {
        buffer.fill(0);
        buffer = undefined;
      }
    }
  }

  return { uploaded, unsupported, pageLimitExceeded };
}
