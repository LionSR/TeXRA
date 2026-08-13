// Node imports
import { Buffer } from 'node:buffer';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { ToolFileAttachment } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { extractMimeSubtype } from '@utils/text/stringUtils';

// Local file imports
import {
  countPdfPagesWithDegrade,
  sanitizeAnthropicFilename,
  uploadFileToFilesApi,
} from './anthropicDocumentHandling';
import { loadAttachmentBuffer, wipeBuffer } from '../utils/toolAttachmentUtils';
import { reportMediaAttachmentFailure } from '../support/mediaAttachmentPolicy';

// Third-party imports
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
  trackedPdfPageCount: number,
  onPageCount: (fileId: string, pageCount: number) => void,
  maxPdfPages: number,
): Promise<UploadToolAttachmentsResult> {
  const uploaded: UploadedAnthropicAttachment[] = [];
  const unsupported: ToolFileAttachment[] = [];
  const pageLimitExceeded: ToolFileAttachment[] = [];

  // Running total: the caller's tracked pages plus the ones this batch adds,
  // so the page budget covers attachments uploaded earlier in this same loop.
  let trackedPages = trackedPdfPageCount;

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
      // An unreadable PDF still uploads and Anthropic enforces the limit
      // server-side, so the local budget check is skipped rather than the
      // attachment dropped. Logged because the budget then undercounts.
      pdfPageCount = await countPdfPagesWithDegrade(buffer, (err) =>
        logger.warn(
          `Unable to count pages in ${attachment.path ?? 'attachment'}; uploading without a local page-limit check: ${toErrorMessage(err)}`,
        ),
      );
      if (trackedPages + pdfPageCount > maxPdfPages) {
        pageLimitExceeded.push(attachment);
        buffer = wipeBuffer(buffer);
        continue;
      }
    }

    try {
      const filename = sanitizeAnthropicFilename(
        attachment.path ??
          (isPdf ? 'document.pdf' : `image.${extractMimeSubtype(normalized)}`),
      );

      const base64Data = buffer.toString('base64');
      const fileId = await uploadFileToFilesApi(
        client,
        buffer,
        filename,
        mimeType,
      );

      if (isPdf && pdfPageCount > 0) {
        onPageCount(fileId, pdfPageCount);
        trackedPages += pdfPageCount;
      }

      uploaded.push({
        attachment,
        fileId,
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
