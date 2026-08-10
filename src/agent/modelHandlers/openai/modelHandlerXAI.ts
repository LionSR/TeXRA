import OpenAI from 'openai';

import type {
  ExtractResponseResult,
  ModelCredentialSelection,
} from '@agent/types/ModelHandlerContracts';
import type { StandardPricingConfig } from '@agent/utils/priceUtils';
import {
  formatXaiAuthUnavailableMessage,
  XaiAuthError,
  xaiCoordinator,
} from '@auth/xai';
import { resolveXaiSubscriptionCapabilitiesForAgentCategory } from '@model/providerCapabilities';
import { isXaiSignedIn } from '@model/xai/xaiSignedIn';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { logOpenAICompatibleClientConfig } from './openAIChatHelpers';
import type { ChatCompletion } from 'openai/resources/chat/completions';

/**
 * Trusted inference origin for OAuth Bearer tokens. User custom endpoints /
 * relay / OpenRouter must never receive the SuperGrok access token.
 */
const XAI_SUBSCRIPTION_BASE_URL = 'https://api.x.ai/v1';

/**
 * Handler for xAI models using OpenAI-compatible API.
 *
 * When "Prefer Grok subscription" is on **and** the user is signed in, requests
 * authenticate with the OAuth access token as the SDK `apiKey` (Bearer) against
 * the trusted `api.x.ai` surface only. Prefer-on without a session falls through
 * to the API-key / relay path (preference is not a hard requirement).
 * EXPERIMENTAL: see docs/proposals/2026-08-04-xai-grok-oauth-subscription.md.
 *
 * Note: the legacy grok-4 generation (deprecated May 2026) rejected the
 * reasoning_effort parameter outright. Current reasoning models (grok-4.3,
 * grok-4.5) document low/medium/high effort control; this handler normalizes
 * unsupported effort levels before sending them to xAI.
 *
 * processThinkingBlock is inherited from ModelHandlerOpenAI which already
 * extracts reasoning_content from the response message.
 *
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 */
export class ModelHandlerXAI extends ModelHandlerOpenAI {
  protected override validateReasoningEffort(effort: string): string {
    // xhigh only exists on the multi-agent variant, where it means agent count.
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      return effort;
    }

    this.logger.warn(
      `xAI models only support 'low', 'medium', or 'high' reasoning effort. Converting '${effort}' to 'high'.`,
    );
    return 'high';
  }

  /** Prefer is on and this model is xAI-eligible (ignores sign-in). */
  private prefersSubscriptionRoute(
    selection: ModelCredentialSelection,
  ): boolean {
    if (selection !== 'configured') return false;
    return (
      resolveXaiSubscriptionCapabilitiesForAgentCategory(
        this.config,
        getUseOpenRouter(),
      )?.authMode === 'xai-subscription'
    );
  }

  /**
   * Prefer on, model eligible, and a live Grok session. Prefer alone does not
   * force OAuth — unsigned prefer falls back to the API key path.
   */
  private async wantsSubscriptionRoute(
    selection: ModelCredentialSelection,
  ): Promise<boolean> {
    if (!this.prefersSubscriptionRoute(selection)) return false;
    return isXaiSignedIn();
  }

  /** Subscription usage is billed by plan, not per token. */
  protected override standardPricingConfig(): StandardPricingConfig {
    if (
      this.activeCredentialRoute === 'xai-subscription' ||
      this.getLastCredentialUsageRoute() === 'xai-subscription'
    ) {
      return {
        ...super.standardPricingConfig(),
        inputPrice: 0,
        outputPrice: 0,
      };
    }
    return super.standardPricingConfig();
  }

  /**
   * While a subscription request is in flight, report the trusted xAI origin
   * (never a user custom endpoint or relay) so retries stay on the same surface.
   */
  public override getBaseUrl(): string | null {
    if (this.activeCredentialRoute === 'xai-subscription') {
      return XAI_SUBSCRIPTION_BASE_URL;
    }
    return super.getBaseUrl();
  }

  override async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<OpenAI> {
    if (!(await this.wantsSubscriptionRoute(selection))) {
      if (this.prefersSubscriptionRoute(selection)) {
        this.logger.debug(
          'Prefer Grok subscription is on but no signed-in session: using the xAI API key path.',
        );
      }
      return super.getClient(selection);
    }

    const apiKey = await this.resolveAccessToken();
    this.logger.debug(
      `Using Grok subscription (xAI OAuth). Base URL: ${XAI_SUBSCRIPTION_BASE_URL}`,
    );
    const client = new OpenAI({
      apiKey,
      // Never send the OAuth token to custom endpoints, OpenRouter, or relay.
      baseURL: XAI_SUBSCRIPTION_BASE_URL,
      fetch: this.longRunningModelFetch,
      maxRetries: 0,
    });
    logOpenAICompatibleClientConfig(
      this.logger,
      this.config,
      client.baseURL,
      'xai-subscription',
      false,
    );
    return this.rememberClientCredentialRoute(
      client,
      'xai-subscription',
      apiKey,
    );
  }

  private async resolveAccessToken(): Promise<string> {
    try {
      return await xaiCoordinator().getFreshAccessToken();
    } catch (error) {
      if (error instanceof XaiAuthError) {
        throw new Error(formatXaiAuthUnavailableMessage(error), {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Extracts response text and usage statistics from API response. */
  override extractResponse(
    responseObject: ChatCompletion,
    endTag: string,
  ): ExtractResponseResult {
    const result = super.extractResponse(responseObject, endTag);

    // Log reasoning tokens if present (xAI-specific debug info)
    const reasoningTokens =
      responseObject.usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      this.logger.debug(`Found reasoning tokens: ${reasoningTokens}`);
    }

    return result;
  }
}
