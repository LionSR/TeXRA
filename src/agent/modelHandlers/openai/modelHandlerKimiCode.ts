/**
 * Kimi Code (Moonshot coding-subscription) model handler.
 *
 * A thin variant of the Kimi chat-completions handler that targets the managed
 * endpoint `https://api.kimi.com/coding/v1` and authenticates with either the
 * user's Kimi Code OAuth session (device-flow login, EXPERIMENTAL — borrowed
 * kimi-cli client id) or the documented Kimi Code console API key.
 *
 * Two model shapes route here (see `@model/kimiCodeSubscriptionRouting`):
 *  - exclusive plan aliases (`kimi-for-coding`, `-highspeed`): the coding
 *    endpoint is their only backend, so the Kimi Code profile is always
 *    active and only the credential choice varies per request;
 *  - dual-backend `kimi3`: active only while the "prefer Kimi Code
 *    subscription" switch (re-read per request, mirroring Codex) routes it
 *    here; switched off mid-run, the same instance transparently falls back
 *    to the inherited open-platform path. Its wire id differs per backend
 *    (`kimi-k3` open platform vs `k3` here).
 */
import OpenAI from 'openai';

import type { StandardPricingConfig } from '@agent/utils/priceUtils';
import {
  KIMI_CODE_BASE_URL,
  KimiCodeAuthError,
  formatKimiCodeAuthUnavailableMessage,
  isPreferKimiCodeSubscription,
  kimiCodeClientHeaders,
  kimiCodeCoordinator,
} from '@auth/kimiCode';
import type { ToolDefinition } from '@model';
import {
  KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW,
  isKimiCodeExclusiveModel,
  isKimiCodeOAuthAllowedForAgentCategory,
  kimiCodeWireModelId,
} from '@model/kimiCodeSubscriptionRouting';

import { ModelHandlerKimi } from './modelHandlerKimi';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export class ModelHandlerKimiCode extends ModelHandlerKimi {
  /**
   * Whether this request runs against the Kimi Code endpoint. Exclusive plan
   * aliases have no other backend; `kimi3` follows the preference switch,
   * re-read per request so flipping it mid-run reroutes the next attempt on
   * this same instance (Codex pattern).
   */
  private isKimiCodeRouteActive(): boolean {
    return (
      isKimiCodeExclusiveModel(this.config) || isPreferKimiCodeSubscription()
    );
  }

  /**
   * OAuth access token when the subscription preference/category allow and a
   * session exists; otherwise the Kimi Code console API key. An expired or
   * absent session falls back to the key silently — dead sessions surface an
   * actionable error only when no key exists either.
   */
  protected override async getApiKey(): Promise<string> {
    if (!this.isKimiCodeRouteActive()) return super.getApiKey();

    if (isKimiCodeOAuthAllowedForAgentCategory(this.agentCategory)) {
      try {
        return await kimiCodeCoordinator().getFreshAccessToken();
      } catch (error) {
        if (!(error instanceof KimiCodeAuthError)) throw error;
        if (!error.needsReauth) {
          // Transient (network/5xx): the session may still be valid — do not
          // silently burn console-key quota; surface the retryable error.
          throw new Error(formatKimiCodeAuthUnavailableMessage(error), {
            cause: error,
          });
        }
        this.logger.debug(
          'No usable Kimi Code session; falling back to the console API key.',
        );
      }
    }
    return this.fetchApiKeyOrThrow(
      'kimiCode',
      'Kimi Code requires a credential: sign in with your Kimi membership, or set a Kimi Code console API key (https://www.kimi.com/code/console).',
    );
  }

  public override getBaseUrl(): string | null {
    return this.isKimiCodeRouteActive()
      ? KIMI_CODE_BASE_URL
      : super.getBaseUrl();
  }

  /** Kimi Code requests never route through the TeXRA relay. */
  protected override shouldUseServerSideKeys(): boolean {
    return this.isKimiCodeRouteActive() ? false : super.shouldUseServerSideKeys();
  }

  protected override async createOpenAIClient(
    providerName?: string,
  ): Promise<OpenAI> {
    if (!this.isKimiCodeRouteActive()) {
      return super.createOpenAIClient(providerName);
    }
    const apiKey = await this.getApiKey();
    this.logger.debug(`Using Kimi Code. Base URL: ${KIMI_CODE_BASE_URL}`);
    return new OpenAI({
      apiKey,
      baseURL: KIMI_CODE_BASE_URL,
      // kimi-cli-shaped device fingerprint; the backend expects these on
      // token requests and community clients send them on inference too.
      defaultHeaders: await kimiCodeClientHeaders(),
    });
  }

  /** Usage is covered by the membership — zero-rate while routed here. */
  protected override standardPricingConfig(): StandardPricingConfig {
    const base = super.standardPricingConfig();
    return this.isKimiCodeRouteActive()
      ? { ...base, inputPrice: 0, outputPrice: 0 }
      : base;
  }

  /**
   * Conservative tier cap: Moderato serves 256K; only Allegretto+ unlocks the
   * registry's full window on `kimi3`.
   */
  public override getEffectiveContextWindow(): number {
    const base = super.getEffectiveContextWindow();
    return this.isKimiCodeRouteActive()
      ? Math.min(KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW, base)
      : base;
  }

  /** The tokenizer estimate endpoint is unverified on the coding endpoint. */
  override get supportsTokenCounting(): boolean {
    return this.isKimiCodeRouteActive()
      ? this.capabilities.supportsTokenCounting
      : super.supportsTokenCounting;
  }

  protected override buildChatBaseParams(
    messages: ChatCompletionMessageParam[],
    temperature?: number,
    systemPrompt?: string,
    endTag?: string,
    tools?: ToolDefinition[],
  ) {
    const params = super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
    if (this.isKimiCodeRouteActive()) {
      params.model = kimiCodeWireModelId(this.config);
    }
    return params;
  }

  protected override buildCompactionSummaryParams(
    conversationMessages: ChatCompletionMessageParam[],
    systemPrompt: string,
  ) {
    const params = super.buildCompactionSummaryParams(
      conversationMessages,
      systemPrompt,
    );
    if (this.isKimiCodeRouteActive()) {
      params.model = kimiCodeWireModelId(this.config);
    }
    return params;
  }
}
