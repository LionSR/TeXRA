import { Buffer } from 'node:buffer';

import { GoogleGenAI, type File } from '@google/genai';
import { ReasoningEffort, type ModelCapabilities } from 'llm-zoo';

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
 * setup, Gemini-3 detection, and reasoning->thinking-level mapping are identical
 * in shape and were previously copy-pasted across the two files.
 *
 * The mapping helpers are generic over the per-handler value space: the chat
 * handler emits SDK `ThinkingLevel` enums while the Interactions handler emits
 * lowercase string literals, so callers supply their own level values and the
 * matching message labels to keep log output byte-identical.
 */

/** Whether the model is a Gemini 3 variant (different thinking/media rules). */
export function isGemini3Model(fullName: string): boolean {
  return /^gemini-3[\.\-]/.test(fullName);
}

/** Whether the model can accept file attachments (image/video or native audio). */
export function supportsGoogleFileUploads(
  capabilities: Pick<
    ModelCapabilities,
    'supportsVision' | 'supportsNativeAudio'
  >,
): boolean {
  return capabilities.supportsVision || capabilities.supportsNativeAudio;
}

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
    const client = new GoogleGenAI({
      apiKey: credential.apiKey,
      httpOptions: {
        baseUrl: credential.baseUrl ?? undefined,
        retryOptions: { attempts: 1 },
      },
    });
    return rememberRoute(client, credential.route);
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

  const client = await createClient(false);
  setCached({ client, credential });
  return client;
}

interface ResolveGeminiThinkingLevelParams<T> {
  reasoningEffort: ReasoningEffort | undefined;
  isGemini3: boolean;
  /** Whether the model is a `-pro` variant (only supports low/high). */
  isPro: boolean;
  logger: AgentTrace;
  /** Per-handler level values (SDK enum vs lowercase string literals). */
  levels: { low: T; medium: T; high: T };
  /** Human-readable level names used in log messages (casing differs per SDK). */
  labels: { low: string; medium: string; high: string };
}

/**
 * Map the model's reasoning effort to a Gemini `thinking_level`.
 *
 * Returns `levels.low` (not `undefined`) for `NONE` so the API does not fall back
 * to its default medium/high — that would defeat the user's intent. Gemini tops
 * out at HIGH thinking, so xhigh/max both map to it; Gemini 3 Pro only supports
 * low/high, so MEDIUM falls back to HIGH for Pro.
 */
export function resolveGeminiThinkingLevel<T>(
  params: ResolveGeminiThinkingLevelParams<T>,
): T | undefined {
  const { reasoningEffort, isGemini3, isPro, logger, levels, labels } = params;

  switch (reasoningEffort) {
    case ReasoningEffort.NONE:
      if (isGemini3) {
        logger.warn(
          `Gemini 3 models can't fully disable thinking. Using thinking_level '${labels.low}'.`,
        );
      }
      return levels.low;

    case ReasoningEffort.LOW:
      return levels.low;

    case ReasoningEffort.MEDIUM:
      if (isGemini3 && isPro) {
        logger.debug(
          `Gemini 3 Pro does not support ${labels.medium} thinking level. Using ${labels.high}.`,
        );
        return levels.high;
      }
      return levels.medium;

    case ReasoningEffort.HIGH:
    case ReasoningEffort.XHIGH:
    case ReasoningEffort.MAX:
      return levels.high;

    default:
      return undefined;
  }
}

interface UploadGoogleMediaEntriesOptions<T> {
  getClient: () => Promise<GoogleGenAI>;
  inlineLimit: number;
  logger: AgentTrace;
  buildInline: (data: string, mimeType: string) => T;
  buildUploaded: (uri: string, mimeType: string) => T;
  onInsertedEntry?: (entry: MediaEntry) => void;
}

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
  const summaries: MediaFileResult[] = [];
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
