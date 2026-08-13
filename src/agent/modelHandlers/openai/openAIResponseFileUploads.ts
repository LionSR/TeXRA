// File and attachment upload helpers for the OpenAI Responses API.
//
// Infrastructure-side helpers that move file payloads to OpenAI's Files API
// (or fall back to inline base64 when uploads are unavailable, e.g. OpenRouter
// routing). They borrow only a logger and an OpenRouter-routing flag from the
// caller, so they live outside the handler as stateless functions.

import { Buffer } from 'node:buffer';
import * as path from 'node:path';

import { dataUriToBuffer } from 'data-uri-to-buffer';
import OpenAI, {
  APIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  toFile,
} from 'openai';

import type { AgentTrace } from '@agent/trace';
import { buildErrorLogData } from '@common/errors/sdkError/providerErrorFormat';
import type { ToolFileAttachment } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { OFFICE_MIME_TYPES } from '@utils/files/mimeUtils';

import { loadAttachmentBuffer, wipeBuffer } from '../utils/toolAttachmentUtils';
import { toDataUrl } from '../support/dataUrl';
import { reportMediaAttachmentFailure } from '../support/mediaAttachmentPolicy';
import { isInputFileContent, isMessageItem } from './openAIResponseContent';
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInputFile,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

/** An attachment that has been uploaded to OpenAI's Files API. */
export interface UploadedOpenAIResponseAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  isImage: boolean;
}

/**
 * MIME types that the OpenAI Responses API accepts as `input_file` content.
 * Composed from the shared OFFICE_MIME_TYPES plus PDF.
 * Images are handled separately via `input_image`.
 */
const INLINEABLE_FILE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  ...OFFICE_MIME_TYPES,
]);

/** Largest attachment inlined as base64 when uploads are unavailable. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** Upload filename for an attachment, falling back when it has no path. */
function attachmentFilename(attachment: ToolFileAttachment): string {
  return isNonEmptyString(attachment.path)
    ? path.basename(attachment.path)
    : 'attachment';
}

/** Options shared by upload helpers that must bypass uploads on OpenRouter. */
interface FileUploadOptions {
  /** Whether requests are routed through OpenRouter (uploads unavailable). */
  openRouterRouting: boolean;
  logger: AgentTrace;
}

/**
 * Replace inline `file_data` payloads with uploaded `file_id` references for
 * any input_file content parts in the given message items.
 */
export async function uploadInlineInputFiles(
  client: OpenAI,
  messageItems: ResponseInputItem[],
  options: FileUploadOptions,
): Promise<void> {
  for (const item of messageItems) {
    if (!isMessageItem(item)) {
      continue;
    }

    const contentList = item.content;

    if (!Array.isArray(contentList)) {
      continue;
    }

    for (const content of contentList) {
      if (
        isInputFileContent(content) &&
        content.file_data &&
        !content.file_id
      ) {
        await replaceFileDataWithUpload(client, content, options);
      }
    }
  }
}

async function replaceFileDataWithUpload(
  client: OpenAI,
  content: ResponseInputFile,
  { openRouterRouting, logger }: FileUploadOptions,
): Promise<void> {
  if (openRouterRouting) {
    logger.debug('OpenRouter routing active; skipping inline file upload.');
    return;
  }

  const fileData = content.file_data;
  if (!fileData) {
    return;
  }

  const filename = content.filename ?? 'document.pdf';
  let buffer: Buffer | undefined;

  try {
    buffer =
      fileData.slice(0, 5).toLowerCase() === 'data:'
        ? Buffer.from(dataUriToBuffer(fileData).buffer)
        : Buffer.from(fileData, 'base64');
    const uploadedFile = await client.files.create({
      file: await toFile(buffer!, filename),
      purpose: 'assistants',
    });

    content.file_id = uploadedFile.id;
    delete content.file_data;
    if ('filename' in content) {
      delete content.filename;
    }
  } catch (err) {
    // Two native SDK timeout signals: APIConnectionTimeoutError (client-side
    // SDK timeout) and APIError with status 408 (server-side Request Timeout).
    // Status 408 is NOT mapped to APIConnectionTimeoutError by the SDK —
    // it falls through to a bare APIError — so both must be checked.
    const isTimeout =
      err instanceof APIConnectionTimeoutError ||
      (err instanceof OpenAIAPIError && err.status === 408);
    if (isTimeout) {
      logger.warn(
        `Timed out uploading file ${filename}. Falling back to inline payload.`,
      );
      return;
    }

    // The retry layer owns the visible failure row for this rethrow; keep
    // the upload diagnostics at debug to avoid a duplicate ERROR entry.
    logger.debug(`Failed to upload file ${filename}`, {
      data: buildErrorLogData(err, { operation: 'upload file' }),
    });
    throw err;
  } finally {
    buffer = wipeBuffer(buffer);
  }
}

/** Upload tool-result attachments to OpenAI's Files API. */
export async function uploadToolAttachments(
  client: OpenAI,
  attachments: ToolFileAttachment[],
  { openRouterRouting, logger }: FileUploadOptions,
): Promise<UploadedOpenAIResponseAttachment[]> {
  if (openRouterRouting) {
    logger.debug(
      'OpenRouter routing active; skipping tool attachment uploads.',
    );
    return [];
  }

  const uploaded: UploadedOpenAIResponseAttachment[] = [];

  for (const attachment of attachments) {
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
      continue;
    }

    try {
      const mimeType = attachment.mimeType ?? 'application/octet-stream';

      const uploadedFile = await client.files.create({
        file: await toFile(buffer!, attachmentFilename(attachment), {
          type: mimeType,
        }),
        purpose: 'assistants',
      });

      uploaded.push({
        attachment,
        fileId: uploadedFile.id,
        isImage: mimeType.startsWith('image/'),
      });
    } catch (err) {
      reportMediaAttachmentFailure(
        logger,
        'toolAttachment',
        err,
        `failed to upload ${attachment.path ?? 'attachment'} to OpenAI`,
      );
    } finally {
      buffer = wipeBuffer(buffer);
    }
  }

  return uploaded;
}

/**
 * Build inline base64 content parts for tool attachments when file uploads
 * are unavailable (e.g., OpenRouter routing). Images use data URI in
 * `image_url`; PDFs and office documents use `file_data` in `input_file`.
 * Unsupported MIME types are skipped.
 */
export async function buildInlineAttachmentParts(
  attachments: ToolFileAttachment[],
  logger: AgentTrace,
): Promise<{
  parts: ResponseFunctionCallOutputItemList;
  inlined: ToolFileAttachment[];
  skipped: ToolFileAttachment[];
}> {
  const parts: ResponseFunctionCallOutputItemList = [];
  const inlined: ToolFileAttachment[] = [];
  const skipped: ToolFileAttachment[] = [];

  for (const attachment of attachments) {
    const mimeType = attachment.mimeType ?? 'application/octet-stream';
    const isImage = mimeType.startsWith('image/');
    const isFileInput = INLINEABLE_FILE_MIME_TYPES.has(mimeType);

    if (!isImage && !isFileInput) {
      skipped.push(attachment);
      continue;
    }

    let buffer: Buffer | undefined;
    try {
      buffer = await loadAttachmentBuffer(attachment);
      if (buffer.length > MAX_INLINE_BYTES) {
        logger.debug(
          `Skipping inline attachment ${attachment.path ?? 'attachment'}: ${buffer.length} bytes exceeds limit`,
        );
        skipped.push(attachment);
        continue;
      }

      const base64 = buffer.toString('base64');

      if (isImage) {
        parts.push({
          type: 'input_image',
          detail: 'auto',
          image_url: toDataUrl(mimeType, base64),
        });
      } else {
        // PDF, office documents, and other file types accepted by input_file
        parts.push({
          type: 'input_file',
          file_data: toDataUrl(mimeType, base64),
          filename: attachmentFilename(attachment),
        });
      }
      inlined.push(attachment);
    } catch (err) {
      logger.debug(
        `Unable to inline attachment ${attachment.path ?? 'attachment'}`,
        {
          data: buildErrorLogData(err, { operation: 'inline attachment' }),
        },
      );
      skipped.push(attachment);
    } finally {
      buffer = wipeBuffer(buffer);
    }
  }

  return { parts, inlined, skipped };
}
