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
 *     requires `store: false`, applied at each wire boundary so the large base
 *     request-builder is untouched: a custom `fetch` for the HTTP paths and
 *     `prepareWireParams` for the WebSocket path (which bypasses `fetch`).
 *     (System prompts already go to top-level `instructions`, which the
 *     backend wants.)
 *
 * All three are gated on the "prefer ChatGPT subscription" preference, re-read
 * per request: if the user turns it off mid-run (e.g. the "Use your own API
 * key" switch after a `usage_limit_reached` error), this handler transparently
 * falls back to the base Responses handler's OpenAI API-key path on the same
 * instance — no handler swap needed.
 */
import OpenAI from 'openai';

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
  CodexAuthError,
  codexBackendModelId,
  codexCoordinator,
  isCodexSubscriptionToolUseOnly,
  isPreferCodexSubscription,
} from '@auth/codex';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getWebSocketEnabled } from '@utils/config/providerConfig';

import { ModelHandlerOpenAIResponse } from './modelHandlerOpenAIResponse';
import type {
  ResponseCreateParamsBase,
  ResponseUsage,
} from 'openai/resources/responses/responses';

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
 *  - drop `background` (the backend has no background mode at all — with both
 *    store/stream satisfied it still answers `400 {"detail":"Unsupported
 *    parameter: background"}`, verified by direct probe; it also forces the
 *    `store:false` that background mode's polling can't use). The handler never
 *    requests background on the subscription path, so this is a belt-and-braces
 *    strip;
 *  - force `store: false` (the backend keeps no server-side state) and
 *    `stream: true` (`400 Stream must be set to true` otherwise);
 *  - guarantee a non-empty top-level `instructions`, hoisting system/developer
 *    items out of `input` into `instructions` (matching Zed/Codex), deduping
 *    text already present, with {@link CODEX_DEFAULT_INSTRUCTIONS} as fallback.
 */
export function rewriteCodexRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...body };
  if (typeof rewritten.model === 'string') {
    rewritten.model = codexBackendModelId({ fullName: rewritten.model });
  }
  delete rewritten.max_output_tokens;
  delete rewritten.background;
  rewritten.store = false;

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

  rewritten.stream = true;

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
  /**
   * The Codex backend has no background mode — a direct probe returns
   * `400 {"detail":"Unsupported parameter: background"}` even with store:false
   * and stream:true satisfied (and `400 Store must be set to false` before
   * that, since background polling needs the server-side state the backend
   * refuses). So while the subscription drives the request, never enter
   * background mode and keep the working default streaming path (the shared
   * `model.useBackgroundResponses` toggle stays default-on for the real OpenAI
   * Responses models, just not for this backend). This is the single gate the
   * request path reads — see {@link ModelHandlerOpenAIResponse.isBackgroundModeActive}.
   * Once the subscription is off, the request runs on the user's OpenAI API key,
   * where the base handler decides background mode normally.
   */
  public override isBackgroundModeActive(): boolean {
    return this.usingSubscription() ? false : super.isBackgroundModeActive();
  }

  /**
   * Clamp the effective context window to the subscription ceiling
   * ({@link CODEX_SUBSCRIPTION_CONTEXT_WINDOW}) while the subscription drives the
   * request. Without it the handler trusts the larger llm-zoo `contextWindow`,
   * so its own token accounting never trips and the first signal of overflow is
   * the backend's opaque `400 context_length_exceeded`. {@link Math.min} keeps
   * it a cap so a model already below the cap is left untouched, and the clamp
   * lifts on the API-key fallback like every other subscription-gated override.
   */
  public override getEffectiveContextWindow(): number {
    const base = super.getEffectiveContextWindow();
    return this.usingSubscription()
      ? Math.min(CODEX_SUBSCRIPTION_CONTEXT_WINDOW, base)
      : base;
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
   * EVERY Codex-specific override below is gated on this so the fallback is a
   * genuine drop to the base handler — once the subscription is off the request
   * runs against the normal OpenAI Responses endpoint with the base handler's
   * full capabilities (token counting, compaction, response chaining, file
   * upload, store:true, WebSocket eligibility), not Codex-restricted ones.
   *
   * (Sign-in is intentionally not re-checked: the switch flips this preference,
   * not the stored session, and an auth lapse still surfaces as an actionable
   * error from {@link resolveAccessToken}.)
   *
   * Also gated on agent category: when {@link isCodexSubscriptionToolUseOnly} is
   * on, only handlers explicitly tagged as tool-use drive the
   * subscription. Workflow and untagged helper handlers fall back to the base
   * API-key / relay path. The Codex backend has no background mode (which
   * workflow runs lean on) and is less stable for long runs, so workflows stay
   * on the more robust path until the subscription backend proves itself. The
   * category is set on launched agents at activation
   * (`AgentLaunchContext.setAgentCategory`); helpers that never launch as
   * agents remain untagged and therefore outside the scoped subscription.
   */
  private usingSubscription(): boolean {
    if (!isPreferCodexSubscription()) return false;
    if (isCodexSubscriptionToolUseOnly()) return this.isToolUseMode();
    return true;
  }

  // The Codex backend is streaming-only (`400 Stream must be set to true`
  // otherwise) and has no background mode, so the subscription always streams.
  // After the fallback to the API key, the base streaming logic applies.
  public override getStreamingConfig(): boolean {
    return this.usingSubscription() ? true : super.getStreamingConfig();
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

  /**
   * The WebSocket transport sends `params` straight through the SDK and never
   * hits {@link codexFetch}, so the Codex wire rewrite the HTTP path gets in the
   * fetch adapter must be applied here too. Without it the un-rewritten params
   * (notably `max_output_tokens`) reach the backend, which answers
   * `400 {"detail":"Unsupported parameter: max_output_tokens"}`. Gated on the
   * subscription; on the API-key fallback the base identity transform applies.
   */
  protected override prepareWireParams(
    params: ResponseCreateParamsBase,
  ): ResponseCreateParamsBase {
    if (!this.usingSubscription()) return params;
    // `rewriteCodexRequestBody` works on the parsed JSON body (a plain record),
    // matching the HTTP `codexFetch` path; the SDK param type has no index
    // signature, so round-trip it through `Record` at this single boundary.
    const rewritten = rewriteCodexRequestBody({ ...params });
    return rewritten as ResponseCreateParamsBase;
  }

  // The Codex backend has no `/responses/input_tokens` or `/compact` endpoint
  // (they return 403); rely on the handler's heuristic fallbacks instead. After
  // the fallback to the OpenAI API key the base capabilities are restored.
  public override get supportsTokenCounting(): boolean {
    return this.usingSubscription() ? false : super.supportsTokenCounting;
  }

  protected override shouldFailWhenFallbackOutputBudgetIsReduced(): boolean {
    return this.usingSubscription();
  }

  public override get supportsManualCompaction(): boolean {
    return this.usingSubscription() ? false : super.supportsManualCompaction;
  }

  protected override get supportsResponseChaining(): boolean {
    return this.usingSubscription() ? false : super.supportsResponseChaining;
  }

  // The Codex backend keeps no server-side state: it mandates store:false
  // (verified by probe — store:true returns `400 Store must be set to false`)
  // and has no background mode to require otherwise. This drives the base
  // request `store` field and gates the encrypted-reasoning replay path: with no
  // previous_response_id chaining, reasoning continuity comes from replaying
  // `reasoning.encrypted_content` blobs in each turn's input instead. Once the
  // subscription is off entirely, the base store:true + chaining is restored.
  protected override get storesResponsesServerSide(): boolean {
    return this.usingSubscription() ? false : super.storesResponsesServerSide;
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

  /**
   * Tag subscription rounds so downstream usage logging and the UI can record
   * them while making clear they are free (the cost above is already 0). The
   * flag rides {@link NormalizedUsage} through `latestUsage` to
   * {@link UsageMonitor}; on the API-key fallback it is omitted and real cost
   * applies.
   */
  public override normalizeUsage(
    rawUsage: ResponseUsage,
    responseTimeMs: number,
  ): NormalizedUsage {
    const usage = super.normalizeUsage(rawUsage, responseTimeMs);
    return this.usingSubscription()
      ? { ...usage, viaChatGptSubscription: true }
      : usage;
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
