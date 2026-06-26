import { GoogleGenAI } from '@google/genai';
import { ReasoningEffort } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';

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

  if (shouldUseServerSideKeys) {
    const credential = await getApiKey();
    const baseUrl = getBaseUrl();
    logger.debug(
      `Using Google GenAI ${sdkLabel} SDK with relay auth. Base URL: ${baseUrl}`,
    );
    return new GoogleGenAI({
      apiKey: credential,
      httpOptions: {
        baseUrl: baseUrl ?? undefined,
        retryOptions: { attempts: 1 },
      },
    });
  }

  if (!cached) {
    const credential = await getApiKey();
    const baseUrl = getBaseUrl();
    logger.debug(`Using Google GenAI ${sdkLabel} SDK. Base URL: ${baseUrl}`);
    const client = new GoogleGenAI({
      apiKey: credential,
      httpOptions: {
        baseUrl: baseUrl ?? undefined,
        retryOptions: { attempts: 1 },
      },
    });
    setCached(client);
    return client;
  }
  return cached;
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
