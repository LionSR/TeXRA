// Inline file-upload helper for the OpenAI Responses API.
//
// Moves inline `file_data` payloads on input messages to OpenAI's Files API
// (skipped under OpenRouter routing, where uploads are unavailable). It
// borrows only a logger and that routing flag from the caller, so it lives
// outside the handler as a stateless function.

import { Buffer } from 'node:buffer';

import { dataUriToBuffer } from 'data-uri-to-buffer';
import OpenAI, {
  APIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  toFile,
} from 'openai';

import type { AgentTrace } from '@agent/trace';
import { buildErrorLogData } from '@common/errors/sdkError/providerErrorFormat';
import { wipeBuffer } from '../utils/toolAttachmentUtils';
import { isInputFileContent, isMessageItem } from './openAIResponseContent';
import type {
  ResponseInputFile,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

/** Options the upload path reads; uploads are bypassed on OpenRouter. */
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
      file: await toFile(buffer, filename),
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
