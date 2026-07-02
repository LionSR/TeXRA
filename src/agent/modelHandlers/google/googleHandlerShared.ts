import { Buffer } from 'node:buffer';

import { GoogleGenAI, type File } from '@google/genai';
import { ReasoningEffort } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import {
  hasEndTag,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import type { FileLocation } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { flexibleFS } from '@utils/files';

import type { MediaFileResult } from '../support/MediaAttachmentProcessor';
import { prepareExistingOutputContent } from '../utils/fileContentUtils';
import { DEFAULT_ATTACHMENT_MIME_TYPE } from '../utils/toolAttachmentUtils';

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

interface ResolveGoogleClientParams {
  /** SDK surface label used in debug logs, e.g. `'Native'` or `'Interactions'`. */
  sdkLabel: string;
  shouldUseServerSideKeys: boolean;
  getApiKey: () => Promise<string>;
  getBaseUrl: () => string | null;
  logger: AgentTrace;
  /** Current cached client (server-side keys bypass the cache). */
  cached: GoogleGenAI | null;
  /** Stores a freshly-created client for reuse with personal API keys. */
  setCached: (client: GoogleGenAI) => void;
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
  const {
    sdkLabel,
    shouldUseServerSideKeys,
    getApiKey,
    getBaseUrl,
    logger,
    cached,
    setCached,
  } = params;

  const createClient = async (relayAuth: boolean): Promise<GoogleGenAI> => {
    const credential = await getApiKey();
    const baseUrl = getBaseUrl();
    logger.debug(
      `Using Google GenAI ${sdkLabel} SDK${relayAuth ? ' with relay auth' : ''}. Base URL: ${baseUrl}`,
    );
    return new GoogleGenAI({
      apiKey: credential,
      httpOptions: {
        baseUrl: baseUrl ?? undefined,
        retryOptions: { attempts: 1 },
      },
    });
  };

  if (shouldUseServerSideKeys) {
    return createClient(true);
  }

  if (cached) {
    return cached;
  }

  const client = await createClient(false);
  setCached(client);
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

  const { getClient, inlineLimit, logger, buildInline, buildUploaded } =
    options;
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
      entry.source_path &&
      entry.source_path.length > 0 &&
      entry.bytes_match_source !== false;
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
      summaries.push({ path: fileName, ok: true });
    } catch (error) {
      summaries.push({ path: fileName, ok: false });
      failures.push(`${fileName}: ${getSdkErrorMessage(error)}`);
    }
  }

  if (summaries.some((summary) => !summary.ok)) {
    logger.warn('Some media files failed to upload via Google GenAI SDK', {
      data: failures,
    });
  }
  return parts;
}

export interface GooglePseudoPrefillAdapter<M> {
  readonly logger: AgentTrace;
  appendPseudoPrefillToUserStep(messages: M[], pseudoPrefillMsg: string): void;
  pushModelText(messages: M[], text: string): void;
  addContinue(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;
}

/**
 * Shared `initializeOutputAndPrefill` body for Google handlers without
 * assistant prefill support.
 */
export async function initializeGooglePseudoPrefillOutputAndPrefill<M>(
  adapter: GooglePseudoPrefillAdapter<M>,
  agentSetting: AgentSetting,
  messages: M[],
  workspaceState: AgentWorkspaceState,
  outputLocation: FileLocation,
  prefill: string,
): Promise<[boolean, M[]]> {
  adapter.logger.debug('Initializing output and prefill.', {
    data: {
      outputPath: outputLocation.absolutePath,
      prefillPreview: prefill.slice(0, 100),
    },
  });

  if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
    adapter.logger.debug(
      `Output file ${outputLocation.absolutePath} does not exist or is empty.`,
    );
    workspaceState.assembly.accumulatedOutput = prefill;

    if (prefill.length === 0) {
      adapter.logger.debug(
        'No prefill provided; skipping pseudo-prefill instruction',
      );
      return [false, messages];
    }

    const pseudoPrefillMsg = `Organize your response with XML tags. Start your response with:\n${prefill}`;
    adapter.appendPseudoPrefillToUserStep(messages, pseudoPrefillMsg);
    adapter.logger.debug('Added pseudo-prefill message.', {
      data: pseudoPrefillMsg,
    });
    return [false, messages];
  }

  adapter.logger.debug(
    `Output file ${outputLocation.absolutePath} exists and is non-trivial. Reading content.`,
  );

  const { fileContent } = await prepareExistingOutputContent(
    outputLocation,
    workspaceState,
    adapter.logger,
  );

  adapter.pushModelText(messages, fileContent);

  if (hasEndTag(agentSetting, fileContent)) {
    adapter.logger.debug(
      'End tag detected in existing file content - skipping generation.',
    );
    return [true, messages];
  }

  adapter.logger.debug(
    'Existing file content found without end tag - continuing generation.',
  );
  adapter.addContinue(messages, workspaceState, agentSetting);
  return [false, messages];
}
