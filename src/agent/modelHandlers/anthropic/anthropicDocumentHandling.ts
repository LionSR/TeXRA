// Standard library imports
import { basename } from 'node:path';

// Third-party imports
import { Buffer } from 'node:buffer';
import { toFile } from '@anthropic-ai/sdk';

// Local imports
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { countPdfPagesInBuffer } from '@utils/media/pdfPageCount';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import { FILES_API_BETA } from './anthropicContextManagement';
import { wipeBuffer } from '../utils/toolAttachmentUtils';

// Type imports - Anthropic SDK
import type { Anthropic } from '@anthropic-ai/sdk';
import type {
  DocumentBlockParam,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { BetaRequestDocumentBlock } from '@anthropic-ai/sdk/resources/beta/messages';

const log = createLog('AnthropicDocuments');

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
        if (nested.type === 'document' && nested.source) {
          documents.push(nested);
        }
      }
    }
  }
  return documents;
}

/**
 * Yields every document block across messages with its typed source, descending
 * into tool_result content. Shared by source analysis and upload replacement so
 * both walk messages identically.
 */
function* iterateDocumentSources(messages: MessageParam[]): Generator<{
  block: DocumentBlockParam;
  source: BetaRequestDocumentBlock['source'];
}> {
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of extractDocumentBlocks(message.content)) {
      yield {
        block,
        source: block.source as BetaRequestDocumentBlock['source'],
      };
    }
  }
}

interface DocumentSourceAnalysis {
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

  for (const { source } of iterateDocumentSources(messages)) {
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

  return { hasFileSource, hasBase64Pdf };
}

/**
 * Sanitizes a filename for Anthropic's Files API.
 */
export function sanitizeAnthropicFilename(filename: string): string {
  const baseName = basename(filename) || filename;
  return sanitizePathSegment(baseName.trim(), {
    // eslint-disable-next-line no-control-regex -- control chars are forbidden in filenames
    invalidCharPattern: /[\x00-\x1F:<>"|?*\\/]/g,
    replacement: '_',
    fallback: 'document.pdf',
    maxLength: 255,
  });
}

interface ReplaceDocumentUploadsResult {
  uploaded: boolean;
  hasFileReference: boolean;
}

/**
 * Counts a PDF's pages, degrading to 0 with a caller-supplied warning when
 * the buffer can't be parsed. An unreadable PDF still uploads; Anthropic
 * enforces its own page limit server-side, so a missing local count only
 * costs the token estimate / budget check. The warning is surfaced so the
 * degraded estimate is attributable.
 */
export async function countPdfPagesWithDegrade(
  buffer: Buffer,
  onCountFailure: (err: unknown) => void,
): Promise<number> {
  try {
    return await countPdfPagesInBuffer(buffer);
  } catch (err) {
    onCountFailure(err);
    return 0;
  }
}

/**
 * Uploads a buffer as a file to the Anthropic Files API, returning the file
 * id. Shared by the message-document replacement and tool-attachment upload
 * pipelines so the upload call (beta header included) lives in exactly one
 * place instead of drifting across two copies.
 */
export async function uploadFileToFilesApi(
  client: Anthropic,
  buffer: Buffer,
  filename: string,
  mediaType: string,
): Promise<string> {
  const uploadedFile = await client.beta.files.upload({
    file: await toFile(buffer, filename, { type: mediaType }),
    betas: [FILES_API_BETA],
  });
  return uploadedFile.id;
}

/**
 * Replaces base64 PDF document data with Files API uploads in the message array.
 * Returns whether any uploads occurred and whether file references exist.
 */
export async function replaceDocumentDataWithUploads(
  client: Anthropic,
  messages: MessageParam[],
  supportsNativePdf: boolean,
  onPageCount: (fileId: string, pageCount: number) => void,
): Promise<ReplaceDocumentUploadsResult> {
  if (!supportsNativePdf) {
    return { uploaded: false, hasFileReference: false };
  }

  let uploaded = false;
  let hasFileReference = false;

  for (const { block, source } of iterateDocumentSources(messages)) {
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

      const pageCount = await countPdfPagesWithDegrade(buffer, (err) =>
        log.warn(
          `Unable to count pages in ${sanitizedFilename}; uploading without a page count: ${toErrorMessage(err)}`,
        ),
      );

      const fileId = await uploadFileToFilesApi(
        client,
        buffer,
        sanitizedFilename,
        mediaType,
      );

      uploadedSource = {
        type: 'file',
        file_id: fileId,
      } as BetaRequestDocumentBlock['source'];

      if (pageCount > 0) {
        onPageCount(fileId, pageCount);
      }
    } finally {
      buffer = wipeBuffer(buffer);
    }

    if (uploadedSource) {
      delete (source as { data?: string }).data;
      (block as BetaRequestDocumentBlock).source = uploadedSource;
      uploaded = true;
      hasFileReference = true;
    }
  }

  return { uploaded, hasFileReference };
}
