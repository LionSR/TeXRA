import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import type { UsageRoute } from '@shared/schemas';

export type ProviderAuthMode = 'chatgpt-subscription';

export interface OpenAIResponseProviderCapabilities {
  readonly backgroundMode: 'base' | 'disabled';
  readonly streaming: 'base' | 'forced';
  readonly webSocket: 'base' | 'global-toggle';
  readonly supportsTokenCounting: boolean;
  readonly supportsManualCompaction: boolean;
  readonly supportsResponseChaining: boolean;
  readonly storesResponsesServerSide: boolean;
  readonly supportsInlineInputFileUpload: boolean;
  readonly supportsToolResultFileUpload: boolean;
  readonly failWhenFallbackOutputBudgetIsReduced: boolean;
}

export interface ProviderCapabilityProfile {
  readonly authMode: ProviderAuthMode;
  readonly contextWindow: number;
  readonly inputPrice: number;
  readonly outputPrice: number;
  readonly usageRoute?: UsageRoute;
  readonly openAIResponses?: OpenAIResponseProviderCapabilities;
}

export interface ProviderCapabilityKey {
  readonly model: ModelConfig;
  readonly useOpenRouter: boolean;
}

type ProviderCapabilityResolver = (
  key: ProviderCapabilityKey,
) => ProviderCapabilityProfile | null;

/** Context window the ChatGPT-subscription (Codex) backend enforces. */
export const CODEX_SUBSCRIPTION_CONTEXT_WINDOW = 272_000;

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `fullName`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The bare model id the Codex backend keys on: the `shortName` when present,
 * else the `fullName` with its llm-zoo date pin stripped.
 */
export function codexBackendModelId(config: {
  readonly shortName?: string;
  readonly fullName: string;
}): string {
  return config.shortName || config.fullName.replace(CODEX_MODEL_DATE_PIN, '');
}

/**
 * Whether `model` is eligible to route through the ChatGPT-subscription
 * (Codex) backend.
 *
 * `llm-zoo` has no dedicated Codex-eligibility capability flag yet (and
 * probing the live Codex models endpoint at refresh time is out of scope
 * here), so this derives eligibility from registry data every OpenAI
 * `ModelConfig` already carries instead of a hand-maintained fullName
 * allowlist: Codex serves OpenAI's current top-reasoning-effort chat models
 * (`capabilities.reasoningEffort === XHIGH`) that haven't been superseded or
 * pulled (`deprecated`/`retired`), plus — as an explicit naming convention —
 * any model whose id contains "codex", since OpenAI's own dedicated
 * Codex-branded releases (e.g. `gpt-5.3-codex`) keep shipping under that
 * name even after they're marked `deprecated` in favor of a newer one. A new
 * top-effort OpenAI release resolves eligible the moment `llm-zoo` ships it,
 * with no hardcoded edit needed here. Over-matching a model the real backend
 * doesn't actually serve is a benign false positive: the backend is the
 * actual gate and rejects models outside the account's tier at request time.
 */
export function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  const unpinnedName = codexBackendModelId(model);
  if (/codex/i.test(unpinnedName)) return true;
  if (model.deprecated || model.retired) return false;
  return model.capabilities.reasoningEffort === ReasoningEffort.XHIGH;
}

const resolveChatGptSubscriptionCapabilities: ProviderCapabilityResolver = ({
  model,
  useOpenRouter,
}) => {
  if (useOpenRouter) return null;
  if (model.provider !== ModelProvider.OPENAI) return null;
  if (model.openRouterOnly) return null;
  if (!isCodexSubscriptionEligible(model)) return null;

  return {
    authMode: 'chatgpt-subscription',
    contextWindow: Math.min(
      CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
      model.contextWindow,
    ),
    inputPrice: 0,
    outputPrice: 0,
    usageRoute: 'chatgpt-subscription',
    openAIResponses: {
      backgroundMode: 'disabled',
      streaming: 'forced',
      webSocket: 'global-toggle',
      supportsTokenCounting: false,
      supportsManualCompaction: false,
      supportsResponseChaining: false,
      storesResponsesServerSide: false,
      supportsInlineInputFileUpload: false,
      supportsToolResultFileUpload: false,
      failWhenFallbackOutputBudgetIsReduced: true,
    },
  };
};

/** Resolve the active ChatGPT-subscription provider profile. */
export function resolveProviderCapabilities(
  key: ProviderCapabilityKey,
): ProviderCapabilityProfile | null {
  return resolveChatGptSubscriptionCapabilities(key);
}
