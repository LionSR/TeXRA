// Standard library imports
import { basename } from 'node:path';

// Third-party imports
import { Buffer } from 'node:buffer';
import { PDFDocument } from '@cantoo/pdf-lib';
import { toFile } from '@anthropic-ai/sdk';

// Local imports
import { FILES_API_BETA } from './anthropicContextManagement';

// Type imports - Anthropic SDK
import type { Anthropic } from '@anthropic-ai/sdk';
import type {
  DocumentBlockParam,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { BetaRequestDocumentBlock } from '@anthropic-ai/sdk/resources/beta/messages';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

/**
 * Extracts all document blocks from a content block array, including those
 * nested inside tool_result blocks. PDFs attached as tool result attachments
 * (e.g., from ArXiv downloads) are nested inside tool_result content and
 * would be missed by a top-level-only scan.
 */
export function extractDocumentBlocks(
  contentBlocks: ContentBlockParam[],
): DocumentBlockParam[] {
  const documents: DocumentBlockParam[] = [];
  for (const block of contentBlocks) {
    if (block.type === 'document' && block.source) {
      documents.push(block);
    } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const nested of block.content) {
        if (
          nested.type === 'document' &&
          (nested as DocumentBlockParam).source
        ) {
          documents.push(nested as DocumentBlockParam);
        }
      }
    }
  }
  return documents;
}

export interface DocumentSourceAnalysis {
  hasFileSource: boolean;
  hasBase64Pdf: boolean;
}

/**
 * Analyzes messages for document source types (file references vs base64 PDFs).
 */
export function analyzeDocumentSources(
  messages: MessageParam[],
): DocumentSourceAnalysis {
  let hasFileSource = false;
  let hasBase64Pdf = false;

  for (const message of messages) {
    const contentBlocks = message.content;
    if (!Array.isArray(contentBlocks)) {
      continue;
    }

    for (const block of extractDocumentBlocks(contentBlocks)) {
      const source = block.source as BetaRequestDocumentBlock['source'];
      if (source.type === 'file') {
        hasFileSource = true;
      } else if (
        source.type === 'base64' &&
        source.media_type === 'application/pdf' &&
        source.data
      ) {
        hasBase64Pdf = true;
      }

      if (hasFileSource && hasBase64Pdf) {
        return { hasFileSource: true, hasBase64Pdf: true };
      }
    }
  }

  return { hasFileSource, hasBase64Pdf };
}

/**
 * Count pages in a PDF buffer without writing to disk.
 * Returns 0 on parse failure so the API can enforce the limit as fallback.
 */
export async function countPdfPagesFromBuffer(buffer: Buffer): Promise<number> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    return pdfDoc.getPageCount();
  } catch {
    return 0;
  }
}

/**
 * Sanitizes a filename for Anthropic's Files API.
 */
export function sanitizeAnthropicFilename(filename: string): string {
  const baseName = basename(filename) || filename;
  const trimmed = baseName.trim();
  const withoutControlChars = Array.from(trimmed, (char) =>
    char.charCodeAt(0) < 32 ? '_' : char,
  ).join('');
  const withoutForbidden = withoutControlChars.replaceAll(/[:<>"|?*\\/]/g, '_');
  const sanitized = withoutForbidden || 'document.pdf';
  return sanitized.slice(0, 255);
}

export interface ReplaceDocumentUploadsResult {
  uploaded: boolean;
  hasFileReference: boolean;
}

/**
 * Replaces base64 PDF document data with Files API uploads in the message array.
 * Returns whether any uploads occurred and whether file references exist.
 */
export async function replaceDocumentDataWithUploads(
  client: Anthropic,
  messages: MessageParam[],
  supportsNativePdf: boolean,
  uploadedPdfPageCounts: Map<string, number>,
): Promise<ReplaceDocumentUploadsResult> {
  if (!supportsNativePdf) {
    return { uploaded: false, hasFileReference: false };
  }

  let uploaded = false;
  let hasFileReference = false;

  for (const message of messages) {
    const contentBlocks = message.content;
    if (!Array.isArray(contentBlocks)) {
      continue;
    }

    for (const block of extractDocumentBlocks(contentBlocks)) {
      const source = block.source as BetaRequestDocumentBlock['source'];

      if (source.type === 'file') {
        hasFileReference = true;
        continue;
      }

      if (source.type !== 'base64') {
        continue;
      }

      const mediaType = source.media_type;
      if (mediaType !== 'application/pdf') {
        continue;
      }

      const base64Data = source.data;
      if (!base64Data) {
        continue;
      }

      const filename = (block.title ?? 'document.pdf').trim() || 'document.pdf';
      const sanitizedFilename = sanitizeAnthropicFilename(filename);
      let buffer: Buffer | undefined;
      let uploadedSource: BetaRequestDocumentBlock['source'] | undefined;

      try {
        buffer = Buffer.from(base64Data, 'base64');

        const pageCount = await countPdfPagesFromBuffer(buffer);

        const uploadedFile = await client.beta.files.upload({
          file: await toFile(buffer!, sanitizedFilename, {
            type: mediaType,
          }),
          betas: [FILES_API_BETA],
        });

        uploadedSource = {
          type: 'file',
          file_id: uploadedFile.id,
        } as BetaRequestDocumentBlock['source'];

        if (pageCount > 0) {
          uploadedPdfPageCounts.set(uploadedFile.id, pageCount);
        }
      } finally {
        if (buffer) {
          buffer.fill(0);
          buffer = undefined;
        }
      }

      if (uploadedSource) {
        delete (source as { data?: string }).data;
        (block as BetaRequestDocumentBlock).source = uploadedSource;
        uploaded = true;
        hasFileReference = true;
      }
    }
  }

  return { uploaded, hasFileReference };
}
