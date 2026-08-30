import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

import type { AgentTrace } from '@agent/trace';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { isNonEmptyString } from '@utils/core';

import { DEFAULT_ATTACHMENT_MIME_TYPE } from '../utils/toolAttachmentUtils';
import type { File, GoogleGenAI } from '@google/genai';

/**
 * Media-attachment pipeline for `ModelHandlerGoogleInteractions`, kept out of
 * the handler file so it stays readable alongside the Interactions-specific
 * wire logic.
 */

/** Where a media block's bytes come from: inline base64 or a File API uri. */
export type GoogleMediaSource = { data: string } | { uri: string };

interface UploadGoogleMediaEntriesOptions<T> {
  getClient: () => Promise<GoogleGenAI>;
  inlineLimit: number;
  logger: AgentTrace;
  buildMedia: (source: GoogleMediaSource, mimeType: string) => T;
  buildLabel: (media: T, fileName: string) => T;
  onInsertedEntry?: (entry: MediaEntry) => void;
}

/**
 * Media-attachment pipeline for the Interactions handler, kept here alongside
 * the client setup so the handler file stays focused on wire logic. Entries
 * are sent inline when small enough, otherwise uploaded through the File API.
 */
export async function uploadGoogleMediaEntries<T>(
  entries: MediaEntry[],
  options: UploadGoogleMediaEntriesOptions<T>,
): Promise<T[]> {
  if (entries.length === 0) {
    return [];
  }

  const {
    getClient,
    inlineLimit,
    logger,
    buildMedia,
    buildLabel,
    onInsertedEntry,
  } = options;
  const client = await getClient();
  const parts: T[] = [];
  const appendMedia = (entry: MediaEntry, media: T): void => {
    parts.push(buildLabel(media, entry.file_name), media);
    onInsertedEntry?.(entry);
  };
  let hadFailure = false;
  const failures: string[] = [];

  for (const entry of entries) {
    const fileName = entry.file_name;
    const mimeType = entry.media_type;
    const inlinePayload = isNonEmptyString(entry.data) ? entry.data : null;

    if (inlinePayload) {
      const payloadBytes = Buffer.byteLength(inlinePayload, 'base64');
      if (payloadBytes <= inlineLimit) {
        logger.debug(
          `Attaching media entry ${fileName} inline (${payloadBytes} bytes).`,
        );
        const media = buildMedia({ data: inlinePayload }, mimeType);
        appendMedia(entry, media);
        continue;
      }
      logger.debug(
        'Media entry exceeds inline limit; falling back to upload.',
        {
          data: { fileName, payloadBytes, inlineLimit },
        },
      );
    }

    const uploadPath =
      entry.bytes_match_source !== false ? entry.source_path : undefined;
    if (!uploadPath) {
      logger.error(
        `Skipping media entry ${fileName} due to missing upload source`,
      );
      hadFailure = true;
      continue;
    }

    try {
      logger.debug(
        `Uploading media entry ${fileName} via Google GenAI SDK from path ${uploadPath}`,
      );
      const uploaded: File = await client.files.upload({
        file: uploadPath,
        // `fileName` may be workspace-relative; displayName is a filename.
        config: { mimeType, displayName: basename(fileName) },
      });
      const fileUri = uploaded.uri;
      if (!fileUri) {
        logger.error(
          `Upload result for ${fileName} is missing a URI. Skipping entry.`,
        );
        hadFailure = true;
        continue;
      }
      const resolvedMimeType =
        uploaded.mimeType || entry.media_type || DEFAULT_ATTACHMENT_MIME_TYPE;
      const media = buildMedia({ uri: fileUri }, resolvedMimeType);
      appendMedia(entry, media);
    } catch (error) {
      hadFailure = true;
      failures.push(`${fileName}: ${getSdkErrorMessage(error)}`);
    }
  }

  if (hadFailure) {
    const failureSummary = failures.join('; ');
    logger.warn(
      failureSummary
        ? `Some media files failed to upload via Google GenAI SDK: ${failureSummary}`
        : 'Some media files failed to upload via Google GenAI SDK',
      {
        data: failures,
      },
    );
  }
  return parts;
}
