import { ModelProvider, type ModelConfig } from 'llm-zoo';

import type { UsageRoute } from '@shared/schemas';

type ProviderAuthMode = 'chatgpt-subscription';

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
 * Read directly from the llm-zoo `codexSubscription` registry flag (added in
 * llm-zoo 1.15.0), which records whether the Codex backend actually serves
 * the model — sourced from the model manifest embedded in the Codex CLI
 * cross-checked against https://developers.openai.com/codex/models.
 *
 * This replaced a registry-derived heuristic (top reasoning-effort tier,
 * `/codex/i` naming, deprecation status, plus three exception tables) that
 * inferred serving status from proxies and broke whenever they diverged from
 * reality: GPT-5.6 ships with a `medium` default reasoning effort, failed the
 * tier gate, and silently fell back to the user's API key. Serving status is
 * a fact about the Codex backend, not derivable from other model fields — so
 * it lives in the registry data, not in code.
 *
 * Requires `model.provider === ModelProvider.OPENAI` — asserted here (not
 * just by callers) since this function is exported and a non-OpenAI
 * `ModelConfig` must never resolve eligible.
 */
export function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  if (model.provider !== ModelProvider.OPENAI) return false;
  return model.codexSubscription === true;
}

/** Resolve the active ChatGPT-subscription provider profile. */
export function resolveProviderCapabilities({
  model,
  useOpenRouter,
}: ProviderCapabilityKey): ProviderCapabilityProfile | null {
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
      // The backend forces `store: false` (see `storesResponsesServerSide`
      // below), so OpenAI's stateful `/responses/compact` endpoint has
      // nothing to act on. Manual compaction is still supported end-to-end
      // via `ModelHandlerOpenAIResponse`'s client-side summarize-and-resend
      // fallback, which the handler picks automatically whenever
      // `storesResponsesServerSide` is false (#7213).
      supportsManualCompaction: true,
      supportsResponseChaining: false,
      storesResponsesServerSide: false,
      supportsInlineInputFileUpload: false,
      supportsToolResultFileUpload: false,
      failWhenFallbackOutputBudgetIsReduced: true,
    },
  };
}
