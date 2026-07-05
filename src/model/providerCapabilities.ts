import { ModelProvider, type ModelConfig } from 'llm-zoo';

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

/**
 * OpenAI models the Codex backend currently serves to ChatGPT subscribers. This
 * is a hardcoded mirror of openai/codex's bundled models.json picker set and
 * WILL go stale; the backend also rejects models above the account's tier.
 */
const CODEX_SUBSCRIPTION_MODEL_FULLNAMES: ReadonlySet<string> = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
]);

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
 * Whether a model id is eligible to route through the ChatGPT subscription.
 * True for the curated set above, date-pinned variants of those ids, or any
 * `*-codex*` name so newer Codex models are picked up without a code change.
 */
export function isCodexSubscriptionEligible(fullName: string): boolean {
  const unpinnedName = fullName.replace(CODEX_MODEL_DATE_PIN, '');
  if (CODEX_SUBSCRIPTION_MODEL_FULLNAMES.has(unpinnedName)) return true;
  return /codex/i.test(fullName);
}

const resolveChatGptSubscriptionCapabilities: ProviderCapabilityResolver = ({
  model,
  useOpenRouter,
}) => {
  if (useOpenRouter) return null;
  if (model.provider !== ModelProvider.OPENAI) return null;
  if (model.openRouterOnly) return null;
  if (!isCodexSubscriptionEligible(codexBackendModelId(model))) return null;

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
