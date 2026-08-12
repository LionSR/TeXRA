/**
 * ChatGPT-subscription (Codex) model handler.
 *
 * A thin variant of the OpenAI Responses handler that authenticates with the
 * user's ChatGPT OAuth session instead of an API key and targets the
 * (unofficial) Codex backend. EXPERIMENTAL — see
 * docs/proposals/2026-06-21-chatgpt-subscription-codex-auth.md.
 *
 * Handler-local differences from the base Responses handler:
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
 * All three are gated by the immutable route captured when a client is built.
 * A later preference change affects the next client, while an already-running
 * request keeps its endpoint, wire shape, limits, pricing, and usage tag aligned.
 */
import OpenAI from 'openai';

import type {
  ModelCredentialRoute,
  ModelCredentialSelection,
} from '@agent/types/ModelHandlerContracts';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CodexAuthError,
  codexCoordinator,
  formatCodexAuthUnavailableMessage,
} from '@auth/codex';
import * as logger from '@logger/logUtils';
import {
  codexBackendModelId,
  resolveCodexSubscriptionProfile,
  type ProviderCapabilityProfile,
} from '@model/providerCapabilities';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';
import { contentToText } from './openAIResponseContent';
import { ModelHandlerOpenAIResponse } from './modelHandlerOpenAIResponse';

const CHANNEL = 'ModelHandlerCodex';

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
export const CODEX_DEFAULT_INSTRUCTIONS = "Follow the user's instructions.";

/** Shape of one `input` array entry that {@link rewriteCodexRequestBody}
 *  reads. Named once here instead of an inline cast per field read. */
interface CodexInputItem {
  role?: unknown;
  content?: unknown;
}

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
 *  - clamp `reasoning.effort` above `medium` down to `medium`: with no
 *    background mode (see above), a `high`/`xhigh`/`max` reasoning turn runs
 *    fully synchronously over this connection and risks the client timing out
 *    before the backend responds.
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

  const reasoning = rewritten.reasoning;
  if (
    reasoning &&
    typeof reasoning === 'object' &&
    'effort' in reasoning &&
    (reasoning.effort === 'high' ||
      reasoning.effort === 'xhigh' ||
      reasoning.effort === 'max')
  ) {
    rewritten.reasoning = { ...reasoning, effort: 'medium' };
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
      const record: CodexInputItem | undefined =
        item && typeof item === 'object' ? (item as CodexInputItem) : undefined;
      if (record?.role === 'system' || record?.role === 'developer') {
        const text = contentToText(record.content).trim();
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

export class ModelHandlerCodex extends ModelHandlerOpenAIResponse {
  /**
   * Thin request-body adapter for the Codex generation endpoint. The SDK
   * continues to own response streaming; this only rewrites the outgoing JSON
   * before delegating to the handler-owned long-running transport.
   */
  private readonly codexFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (
      !init ||
      init.method !== 'POST' ||
      typeof init.body !== 'string' ||
      !isGenerationRequest(url)
    ) {
      return this.longRunningModelFetch(input, init);
    }

    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      init = { ...init, body: JSON.stringify(rewriteCodexRequestBody(body)) };
    } catch (error) {
      // Body is not JSON we can edit; the backend will reject it because the
      // required stream and instruction fields could not be installed.
      logger.warn(
        CHANNEL,
        `Could not adapt Codex request body: ${toErrorMessage(error)}`,
      );
    }

    return this.longRunningModelFetch(input, init);
  };

  /** Capabilities for a captured route, or the configured preference when no
   *  route has been captured yet. */
  private capabilitiesForRoute(
    route: ModelCredentialRoute | NormalizedUsage['usageRoute'],
  ): ProviderCapabilityProfile | null {
    if (route === undefined) return this.configuredSubscriptionCapabilities();
    return route === 'chatgpt-subscription'
      ? this.subscriptionCapabilities()
      : null;
  }

  protected override getActiveProviderCapabilities(): ProviderCapabilityProfile | null {
    return this.capabilitiesForRoute(this.activeCredentialRoute);
  }

  protected override getUsageProviderCapabilities(): ProviderCapabilityProfile | null {
    return this.capabilitiesForRoute(this.getLastCredentialUsageRoute());
  }

  private subscriptionCapabilities(): ProviderCapabilityProfile | null {
    return resolveCodexSubscriptionProfile({
      model: this.config,
      useOpenRouter: false,
    });
  }

  private configuredSubscriptionCapabilities(): ProviderCapabilityProfile | null {
    if (!isPreferCodexSubscription()) return null;
    return this.subscriptionCapabilities();
  }

  private hasConfiguredSubscriptionProfile(): boolean {
    return (
      this.configuredSubscriptionCapabilities()?.authMode ===
      'chatgpt-subscription'
    );
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
    if (
      this.getActiveProviderCapabilities()?.authMode !== 'chatgpt-subscription'
    ) {
      return params;
    }
    // `rewriteCodexRequestBody` works on the parsed JSON body (a plain record),
    // matching the HTTP `codexFetch` path; the SDK param type has no index
    // signature, so round-trip it through `Record` at this single boundary.
    const rewritten = rewriteCodexRequestBody({ ...params });
    return rewritten as ResponseCreateParamsBase;
  }

  /** OAuth access token in place of an API key (becomes the Bearer header),
   *  or the user's OpenAI API key once the subscription preference is off. */
  protected override async getApiKey(): Promise<string> {
    return this.hasConfiguredSubscriptionProfile()
      ? this.resolveAccessToken()
      : super.getApiKey();
  }

  /** The Codex backend while the subscription is active, else the default
   *  OpenAI base from the parent. */
  public override getBaseUrl(): string | null {
    if (this.activeCredentialRoute !== undefined) {
      return this.activeCredentialRoute === 'chatgpt-subscription'
        ? CODEX_BACKEND_BASE_URL
        : super.getBaseUrl();
    }
    return this.hasConfiguredSubscriptionProfile()
      ? CODEX_BACKEND_BASE_URL
      : super.getBaseUrl();
  }

  override async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<OpenAI> {
    const subscriptionCapabilities =
      selection === 'configured'
        ? this.configuredSubscriptionCapabilities()
        : null;
    if (subscriptionCapabilities?.authMode !== 'chatgpt-subscription') {
      // Preference switched off (e.g. after a usage limit) — route this request
      // through the user's OpenAI API key via the standard Responses client.
      this.logger.debug(
        selection === 'personal'
          ? 'Building a personal OpenAI API-key client.'
          : 'ChatGPT subscription preference is off: using the OpenAI API key.',
      );
      return super.getClient(selection);
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
    return this.rememberClientCredentialRoute(
      new OpenAI({
        apiKey,
        baseURL: CODEX_BACKEND_BASE_URL,
        defaultHeaders,
        fetch: this.codexFetch,
        maxRetries: 0,
      }),
      'chatgpt-subscription',
      apiKey,
    );
  }

  /** Fetch a fresh OAuth token, turning auth failures into actionable errors. */
  private async resolveAccessToken(): Promise<string> {
    try {
      return await codexCoordinator().getFreshAccessToken();
    } catch (error) {
      if (error instanceof CodexAuthError) {
        // Preserve the original CodexAuthError (kind/stack) as the cause.
        throw new Error(formatCodexAuthUnavailableMessage(error), {
          cause: error,
        });
      }
      throw error;
    }
  }
}
