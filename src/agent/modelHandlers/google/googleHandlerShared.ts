import { Buffer } from 'node:buffer';

import { GoogleGenAI, type File } from '@google/genai';

import type { AgentTrace } from '@agent/trace';
import type {
  ModelCredentialRoute,
  ResolvedClientCredential,
} from '@agent/types/ModelHandlerContracts';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { isNonEmptyString } from '@utils/core';

import { DEFAULT_ATTACHMENT_MIME_TYPE } from '../utils/toolAttachmentUtils';
import type { MediaFileResult } from '../support/MediaAttachmentProcessor';

/**
 * Shared helpers for the two Google handlers (generateContent chat handler and
 * the Interactions handler). Both use the SAME `GoogleGenAI` SDK, so client
 * setup and the media-attachment pipeline are identical in shape and were
 * previously copy-pasted across the two files. Capability getters that differ
 * only by a per-SDK literal map live on `GoogleModelHandlerBase` instead.
 */

export interface GoogleClientCache {
  readonly client: GoogleGenAI;
  readonly credential: ResolvedClientCredential;
}

interface ResolveGoogleClientParams {
  /** SDK surface label used in debug logs, e.g. `'Native'` or `'Interactions'`. */
  sdkLabel: string;
  credential: ResolvedClientCredential;
  logger: AgentTrace;
  /** Current cached client (server-side keys bypass the cache). */
  cached: GoogleClientCache | null;
  /** Stores a freshly-created client for reuse with personal API keys. */
  setCached: (cache: GoogleClientCache) => void;
  rememberRoute: (
    client: GoogleGenAI,
    route: ModelCredentialRoute,
    credentialSecret: string,
  ) => GoogleGenAI;
}

/**
 * Resolve a `GoogleGenAI` client, refreshing on every call for server-side relay
 * keys (auth tokens expire ~30 mins) and caching for non-expiring personal keys.
 *
 * SDK-level retries are disabled (`retryOptions: { attempts: 1 }`) so that only
 * the flow-level retry loop (`RetryState.getNodeRetryConfig`) governs the user's
 * retry budget — otherwise transient errors would be retried by both the SDK and
 * the flow, multiplying the configured attempt count.
 */
export async function resolveGoogleClient(
  params: ResolveGoogleClientParams,
): Promise<GoogleGenAI> {
  const { sdkLabel, credential, logger, cached, setCached, rememberRoute } =
    params;

  const createClient = (relayAuth: boolean): GoogleGenAI => {
    logger.debug(
      `Using Google GenAI ${sdkLabel} SDK${relayAuth ? ' with relay auth' : ''}. Base URL: ${credential.baseUrl}`,
    );
    // No `retryOptions`: absent, the SDK's apiCall does a single plain fetch
    // (zero SDK retries — the node loop owns retries) and failures surface as
    // structured ApiError WITH `status`. Any retryOptions value — including
    // `{ attempts: 1 }` — switches apiCall into a pRetry wrapper that converts
    // non-ok responses into bare Errors with no status field, blinding the
    // route gate's 429/5xx classification for Google.
    const client = new GoogleGenAI({
      apiKey: credential.apiKey,
      httpOptions: {
        baseUrl: credential.baseUrl ?? undefined,
      },
    });
    return rememberRoute(client, credential.route, credential.apiKey);
  };

  if (credential.route === 'relay') {
    return createClient(true);
  }

  if (
    cached?.credential.apiKey === credential.apiKey &&
    cached.credential.baseUrl === credential.baseUrl &&
    cached.credential.route === credential.route
  ) {
    return cached.client;
  }

  const client = createClient(false);
  setCached({ client, credential });
  return client;
}

interface UploadGoogleMediaEntriesOptions<T> {
  getClient: () => Promise<GoogleGenAI>;
  inlineLimit: number;
  logger: AgentTrace;
  buildInline: (data: string, mimeType: string) => T;
  buildUploaded: (uri: string, mimeType: string) => T;
  onInsertedEntry?: (entry: MediaEntry) => void;
}

type GoogleMediaUploadSummary = Pick<MediaFileResult, 'path' | 'ok'>;

/**
 * Shared media-attachment pipeline for the two Google handlers. Entries are
 * sent inline when small enough, otherwise uploaded through the File API.
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
    buildInline,
    buildUploaded,
    onInsertedEntry,
  } = options;
  const client = await getClient();
  const parts: T[] = [];
  const summaries: GoogleMediaUploadSummary[] = [];
  const failures: string[] = [];

  for (const entry of entries) {
    const fileName = entry.file_name ?? 'unnamed-file';
    const mimeType = entry.media_type ?? DEFAULT_ATTACHMENT_MIME_TYPE;
    const inlinePayload = isNonEmptyString(entry.data) ? entry.data : null;

    if (inlinePayload) {
      const payloadBytes = Buffer.byteLength(inlinePayload, 'base64');
      if (payloadBytes <= inlineLimit) {
        logger.debug(
          `Attaching media entry ${fileName} inline (${payloadBytes} bytes).`,
        );
        parts.push(buildInline(inlinePayload, mimeType));
        onInsertedEntry?.(entry);
        summaries.push({ path: fileName, ok: true });
        continue;
      }
      logger.debug(
        'Media entry exceeds inline limit; falling back to upload.',
        {
          data: { fileName, payloadBytes, inlineLimit },
        },
      );
    }

    const canUseSourcePath =
      entry.source_path && entry.bytes_match_source !== false;
    if (!canUseSourcePath) {
      logger.error(
        `Skipping media entry ${fileName} due to missing upload source`,
      );
      summaries.push({ path: fileName, ok: false });
      continue;
    }

    try {
      const uploadPath = entry.source_path as string;
      logger.debug(
        `Uploading media entry ${fileName} via Google GenAI SDK from path ${uploadPath}`,
      );
      const uploaded: File = await client.files.upload({
        file: uploadPath,
        config: { mimeType, displayName: fileName },
      });
      const fileUri = uploaded.uri;
      if (!fileUri) {
        logger.error(
          `Upload result for ${fileName} is missing a URI. Skipping entry.`,
        );
        summaries.push({ path: fileName, ok: false });
        continue;
      }
      const resolvedMimeType =
        uploaded.mimeType || entry.media_type || DEFAULT_ATTACHMENT_MIME_TYPE;
      parts.push(buildUploaded(fileUri, resolvedMimeType));
      onInsertedEntry?.(entry);
      summaries.push({ path: fileName, ok: true });
    } catch (error) {
      summaries.push({ path: fileName, ok: false });
      failures.push(`${fileName}: ${getSdkErrorMessage(error)}`);
    }
  }

  if (summaries.some((summary) => !summary.ok)) {
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
