/**
 * ChatGPT-subscription (Codex) model handler.
 *
 * A thin variant of the OpenAI Responses handler that authenticates with the
 * user's ChatGPT OAuth session instead of an API key and targets the
 * (unofficial) Codex backend. EXPERIMENTAL — see
 * docs/proposals/chatgpt-subscription-codex-auth.md.
 *
 * Only three things differ from the base Responses handler:
 *  1. credential — the OAuth access token is passed as the SDK `apiKey` (the
 *     SDK derives `Authorization: Bearer <token>` from it), refreshed per turn;
 *  2. endpoint + headers — `…/codex/responses`, plus `chatgpt-account-id`,
 *     `originator: texra` (our own, never `codex_cli_rs`), and the responses
 *     beta header;
 *  3. request shaping — the Codex backend rejects `max_output_tokens` and
 *     requires `store: false`, applied via a custom `fetch` so the large base
 *     request-builder is untouched. (System prompts already go to top-level
 *     `instructions`, which the backend wants.)
 *
 * All three are gated on the "prefer ChatGPT subscription" preference, re-read
 * per request: if the user turns it off mid-run (e.g. the "Use your own API
 * key" switch after a `usage_limit_reached` error), this handler transparently
 * falls back to the base Responses handler's OpenAI API-key path on the same
 * instance — no handler swap needed.
 */
import OpenAI from 'openai';

import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CodexAuthError,
  codexCoordinator,
  isPreferCodexSubscription,
} from '@auth/codex';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

import { ModelHandlerOpenAIResponse } from './modelHandlerOpenAIResponse';
import type { ResponseUsage } from 'openai/resources/responses/responses';

const CHANNEL = 'ModelHandlerCodex';
logger.initialize(CHANNEL);

/** Flatten Responses message content (string or typed parts) to plain text. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True only for the generation endpoint (`…/responses`), not `…/responses/input_tokens`. */
function isGenerationRequest(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/responses');
  } catch {
    return url.endsWith('/responses');
  }
}

/**
 * Rewrite the outgoing Responses request for the Codex backend:
 *  - drop `max_output_tokens` (rejected as unsupported) and `background`
 *    (the backend has no polling mode);
 *  - force `store: false`;
 *  - guarantee a non-empty top-level `instructions` (the backend returns
 *    `400 {"detail":"Instructions are required"}` otherwise), hoisting
 *    system/developer items out of `input` into `instructions` (matching
 *    Zed/Codex) with a minimal fallback;
 *  - force `stream: true` (the backend returns `400 Stream must be set to true`
 *    otherwise).
 *
 * The handler forces the streaming path (`getStreamingConfig` → true), so the
 * SDK's own `ResponseStream` accumulates the deltas natively — no SSE parsing
 * here. Token-counting / compaction endpoints are disabled at the capability
 * level, so only the generation endpoint reaches this rewrite.
 */
const codexFetch = (async (input, init) => {
  const url = requestUrl(input);
  if (
    !init ||
    init.method !== 'POST' ||
    typeof init.body !== 'string' ||
    !isGenerationRequest(url)
  ) {
    return fetch(input, init);
  }

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    delete body.max_output_tokens;
    delete body.background;
    body.store = false;

    const instructions: string[] = [];
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      instructions.push(body.instructions.trim());
    }
    if (Array.isArray(body.input)) {
      const kept: unknown[] = [];
      for (const item of body.input) {
        const role =
          item && typeof item === 'object'
            ? (item as { role?: unknown }).role
            : undefined;
        if (role === 'system' || role === 'developer') {
          const text = partsToText(
            (item as { content?: unknown }).content,
          ).trim();
          if (
            text &&
            !instructions.some((instruction) => instruction.includes(text))
          ) {
            instructions.push(text);
          }
        } else {
          kept.push(item);
        }
      }
      body.input = kept;
    }
    body.instructions =
      instructions.join('\n\n') || 'You are a helpful assistant.';

    body.stream = true;
    init = { ...init, body: JSON.stringify(body) };
  } catch (error) {
    // Body isn't JSON we can edit — the backend will reject it (missing
    // stream/instructions). Log so the resulting 400 is diagnosable.
    logger.warn(
      CHANNEL,
      `Could not adapt Codex request body: ${toErrorMessage(error)}`,
    );
  }

  return fetch(input, init);
}) satisfies typeof fetch;

export class ModelHandlerCodex extends ModelHandlerOpenAIResponse {
  protected override backgroundModeSupported = false;

  // The Codex backend is streaming-only (`400 Stream must be set to true`
  // otherwise), so always take the streaming path regardless of the user's
  // streaming toggle. The SDK's `ResponseStream` then accumulates the deltas
  // natively, and the base path rebuilds `output` from the streamed
  // `output_item.done` events (the backend leaves `response.completed.output`
  // empty).
  public override getStreamingConfig(): boolean {
    return true;
  }

  // The Codex backend has no `/responses/input_tokens` or `/compact` endpoint
  // (they return 403); rely on the handler's heuristic fallbacks instead.
  public override get supportsTokenCounting(): boolean {
    return false;
  }

  public override get supportsManualCompaction(): boolean {
    return false;
  }

  protected override get supportsResponseChaining(): boolean {
    return false;
  }

  protected override get supportsInlineInputFileUpload(): boolean {
    return false;
  }

  protected override get supportsToolResultFileUpload(): boolean {
    return false;
  }

  /**
   * Whether this handler should still drive the ChatGPT subscription. Re-read
   * per request (not cached at construction) so that turning the preference off
   * mid-run — e.g. via the "Use your own API key" retry switch after a
   * `usage_limit_reached` error — makes the next attempt fall back to the
   * user's OpenAI API key on this same handler instance. The OpenAI client is
   * rebuilt every request from `getApiKey()`/`getBaseUrl()`, so re-resolving
   * here is enough to reroute the in-place retry, mirroring how the base
   * handler re-resolves relay vs direct credentials per request.
   *
   * (Sign-in is intentionally not re-checked: the switch flips this preference,
   * not the stored session, and an auth lapse still surfaces as an actionable
   * error from {@link resolveAccessToken}.)
   */
  private usingSubscription(): boolean {
    return isPreferCodexSubscription();
  }

  /** Subscription usage consumes ChatGPT quota, not TeXRA-tracked API spend;
   *  once switched to the API key, fall back to real per-token pricing. */
  public override computePrice(responseUsage: ResponseUsage): number {
    return this.usingSubscription() ? 0 : super.computePrice(responseUsage);
  }

  /** OAuth access token in place of an API key (becomes the Bearer header),
   *  or the user's OpenAI API key once the subscription preference is off. */
  public override async getApiKey(): Promise<string> {
    return this.usingSubscription()
      ? this.resolveAccessToken()
      : super.getApiKey();
  }

  /** The Codex backend while the subscription is active (also disables the
   *  WebSocket transport path), else the default OpenAI base from the parent. */
  public override getBaseUrl(): string | null {
    return this.usingSubscription() ? CODEX_BACKEND_BASE_URL : super.getBaseUrl();
  }

  protected override async createOpenAIClient(): Promise<OpenAI> {
    if (!this.usingSubscription()) {
      // Preference switched off (e.g. after a usage limit) — route this request
      // through the user's OpenAI API key via the standard Responses client.
      this.logger.debug(
        'ChatGPT subscription preference is off — using the OpenAI API key.',
      );
      return super.createOpenAIClient();
    }

    const apiKey = await this.resolveAccessToken();
    const accountId = await codexCoordinator().getAccountId();
    const defaultHeaders: Record<string, string> = {
      [CODEX_ORIGINATOR_HEADER]: CODEX_ORIGINATOR,
      [CODEX_BETA_HEADER]: CODEX_BETA_VALUE,
    };
    // Sent only when present; the backend tolerates its absence.
    if (accountId) defaultHeaders[CODEX_ACCOUNT_ID_HEADER] = accountId;

    this.logger.debug(
      `Using ChatGPT subscription (Codex). Base URL: ${CODEX_BACKEND_BASE_URL}`,
    );
    return new OpenAI({
      apiKey,
      baseURL: CODEX_BACKEND_BASE_URL,
      defaultHeaders,
      fetch: codexFetch,
    });
  }

  /** Fetch a fresh OAuth token, turning auth failures into actionable errors. */
  private async resolveAccessToken(): Promise<string> {
    try {
      return await codexCoordinator().getFreshAccessToken();
    } catch (error) {
      if (error instanceof CodexAuthError) {
        const action = error.needsReauth
          ? 'Sign in with ChatGPT again, or turn off "Prefer ChatGPT subscription".'
          : 'Try again in a moment, or turn off "Prefer ChatGPT subscription".';
        // Preserve the original CodexAuthError (kind/stack) as the cause.
        throw new Error(
          `ChatGPT subscription unavailable: ${error.message} ${action}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
