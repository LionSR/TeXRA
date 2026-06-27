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
import { getWebSocketEnabled } from '@utils/config/providerConfig';

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
export function isGenerationRequest(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/responses');
  } catch {
    return url.endsWith('/responses');
  }
}

/** Default top-level `instructions` for the Codex backend when the request
 *  carries none — it returns `400 {"detail":"Instructions are required"}`
 *  otherwise. */
export const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

/**
 * Rewrite a parsed Responses request body for the (unofficial) Codex backend.
 * Pure: returns a new top-level object and never mutates `body`, so the
 * reverse-engineered wire contract is unit-testable without a live request (see
 * CodexRequestRewrite tests). Each adjustment prevents a specific backend 400:
 *  - drop `max_output_tokens` (rejected as unsupported);
 *  - force `store: false` (the backend keeps no server-side state) and
 *    `stream: true` (`400 Stream must be set to true` otherwise);
 *  - guarantee a non-empty top-level `instructions`, hoisting system/developer
 *    items out of `input` into `instructions` (matching Zed/Codex), deduping
 *    text already present, with {@link CODEX_DEFAULT_INSTRUCTIONS} as fallback.
 *
 * Background mode is the one exception: when the handler set `background: true`
 * (with store:true via `storesResponsesServerSide`), the transport fields are
 * left untouched so the real backend verdict is observed rather than masked.
 * `instructions` is still normalized — that requirement holds either way.
 */
export function rewriteCodexRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...body };
  delete rewritten.max_output_tokens;

  const testingBackground = rewritten.background === true;
  if (!testingBackground) {
    delete rewritten.background;
    rewritten.store = false;
  }

  const instructions: string[] = [];
  if (
    typeof rewritten.instructions === 'string' &&
    rewritten.instructions.trim()
  ) {
    instructions.push(rewritten.instructions.trim());
  }
  if (Array.isArray(rewritten.input)) {
    const kept: unknown[] = [];
    for (const item of rewritten.input) {
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
    rewritten.input = kept;
  }
  rewritten.instructions =
    instructions.join('\n\n') || CODEX_DEFAULT_INSTRUCTIONS;

  if (!testingBackground) {
    rewritten.stream = true;
  }

  return rewritten;
}

/**
 * Custom `fetch` for the Codex client: a thin parse → {@link
 * rewriteCodexRequestBody} → serialize adapter on the generation endpoint, so
 * the large base request-builder is untouched. The handler forces the streaming
 * path (`getStreamingConfig` → true), so the SDK's own `ResponseStream`
 * accumulates the deltas natively — no SSE parsing here. Token-counting /
 * compaction endpoints are disabled at the capability level, so only the
 * generation endpoint reaches this rewrite.
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
    init = { ...init, body: JSON.stringify(rewriteCodexRequestBody(body)) };
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
  // Background mode is honored through the SAME `model.useBackgroundResponses`
  // toggle every OpenAI Responses model uses (plus the usual workflow + GPT
  // eligibility) — no Codex-specific flag. EXPERIMENTAL on this backend: it
  // forces store:false and has no polling endpoint, so a background request
  // very likely fails; the toggle exists so it can be tested in practice.
  protected override backgroundModeSupported = true;

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
   * EVERY Codex-specific override below is gated on this so the fallback is a
   * genuine drop to the base handler — once the subscription is off the request
   * runs against the normal OpenAI Responses endpoint with the base handler's
   * full capabilities (token counting, compaction, response chaining, file
   * upload, store:true, WebSocket eligibility), not Codex-restricted ones.
   *
   * (Sign-in is intentionally not re-checked: the switch flips this preference,
   * not the stored session, and an auth lapse still surfaces as an actionable
   * error from {@link resolveAccessToken}.)
   */
  private usingSubscription(): boolean {
    return isPreferCodexSubscription();
  }

  // The Codex backend is streaming-only (`400 Stream must be set to true`
  // otherwise), so take the streaming path unless background mode is active
  // (then the base polling path needs non-streaming). After the fallback the
  // base streaming logic applies.
  public override getStreamingConfig(): boolean {
    return this.usingSubscription()
      ? !this.isBackgroundModeActive()
      : super.getStreamingConfig();
  }

  /**
   * Allow WebSocket transport against the Codex backend whenever the SAME global
   * `texra.websocket.openai` toggle is on (`getWebSocketEnabled()`) — no
   * Codex-specific flag. The SDK derives the WebSocket URL + auth from the
   * (Codex) client, so this targets the Codex endpoint; whether that endpoint
   * speaks WebSocket is what's being tested. Gated on the subscription: once it
   * is off, the base rule (default OpenAI endpoint only) applies, so WebSocket
   * is never attempted against a relay/proxy/custom base URL.
   */
  protected override isWebSocketModeEnabled(): boolean {
    return this.usingSubscription()
      ? getWebSocketEnabled()
      : super.isWebSocketModeEnabled();
  }

  // The Codex backend has no `/responses/input_tokens` or `/compact` endpoint
  // (they return 403); rely on the handler's heuristic fallbacks instead. After
  // the fallback to the OpenAI API key the base capabilities are restored.
  public override get supportsTokenCounting(): boolean {
    return this.usingSubscription() ? false : super.supportsTokenCounting;
  }

  public override get supportsManualCompaction(): boolean {
    return this.usingSubscription() ? false : super.supportsManualCompaction;
  }

  protected override get supportsResponseChaining(): boolean {
    return this.usingSubscription() ? false : super.supportsResponseChaining;
  }

  // The Codex backend keeps no server-side state (store:false, also enforced at
  // the fetch layer). This drives the base request `store` field and gates the
  // encrypted-reasoning replay path: with no previous_response_id chaining,
  // reasoning continuity comes from replaying `reasoning.encrypted_content`
  // blobs in each turn's input instead.
  //
  // Background mode (polling) needs server-side storage, so when it's active
  // store:true is requested — which also auto-disables the encrypted-reasoning
  // replay (reasoning then lives server-side, like the base path). Once the
  // subscription is off entirely, the base store:true + chaining is restored.
  protected override get storesResponsesServerSide(): boolean {
    if (!this.usingSubscription()) return super.storesResponsesServerSide;
    return this.isBackgroundModeActive();
  }

  protected override get supportsInlineInputFileUpload(): boolean {
    return this.usingSubscription()
      ? false
      : super.supportsInlineInputFileUpload;
  }

  protected override get supportsToolResultFileUpload(): boolean {
    return this.usingSubscription()
      ? false
      : super.supportsToolResultFileUpload;
  }

  /** Subscription usage consumes ChatGPT quota, not TeXRA-tracked API spend;
   *  once switched to the API key, fall back to real per-token pricing. */
  public override computePrice(responseUsage: ResponseUsage): number {
    return this.usingSubscription() ? 0 : super.computePrice(responseUsage);
  }

  /** OAuth access token in place of an API key (becomes the Bearer header),
   *  or the user's OpenAI API key once the subscription preference is off. */
  protected override async getApiKey(): Promise<string> {
    return this.usingSubscription()
      ? this.resolveAccessToken()
      : super.getApiKey();
  }

  /** The Codex backend while the subscription is active (also disables the
   *  WebSocket transport path), else the default OpenAI base from the parent. */
  public override getBaseUrl(): string | null {
    return this.usingSubscription()
      ? CODEX_BACKEND_BASE_URL
      : super.getBaseUrl();
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
