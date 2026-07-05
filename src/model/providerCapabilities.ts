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
 * Known false positive: an OpenAI model the registry-derived heuristic below
 * would mark eligible (top reasoning-effort tier, live, non-`codex` name),
 * but that the Codex backend does not actually serve. `gpt-5.4-nano` is
 * API-only — routing it through `/codex/responses` fails at request time
 * instead of using the normal API-key path, so it must be excluded outright
 * rather than left for the backend to reject. Keyed on
 * {@link codexBackendModelId} (shortName, or date-unpinned fullName) so a
 * llm-zoo date-pin bump doesn't silently drop the exception.
 */
const CODEX_INELIGIBLE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'gpt-5.4-nano',
]);

/**
 * Known false negative: an OpenAI model the registry marks merely
 * `deprecated` (superseded by a newer release, not pulled) that the Codex
 * backend still actually serves. The old hand-maintained fullName allowlist
 * this heuristic replaced still routed `gpt-5.4` through the ChatGPT
 * subscription after `gpt-5.5` shipped; treating every `deprecated` model as
 * ineligible would regress that. `deprecated` still disqualifies by default
 * — only these explicit, known-still-served exceptions bypass it. Keyed on
 * {@link codexBackendModelId}.
 */
const CODEX_DEPRECATED_EXCEPTIONS: ReadonlySet<string> = new Set(['gpt-5.4']);

/**
 * Whether `model` is eligible to route through the ChatGPT-subscription
 * (Codex) backend.
 *
 * `llm-zoo` has no dedicated Codex-eligibility capability flag yet (and
 * probing the live Codex models endpoint at refresh time is out of scope
 * here), so this derives eligibility from registry data every OpenAI
 * `ModelConfig` already carries instead of a hand-maintained fullName
 * allowlist: Codex serves OpenAI's current top-reasoning-effort chat models
 * (`capabilities.reasoningEffort` at `XHIGH` or the higher `MAX` tier) that
 * haven't been pulled (`retired`) or superseded (`deprecated`), plus — as an
 * explicit naming convention — any model whose id contains "codex", since
 * OpenAI's own dedicated Codex-branded releases (e.g. `gpt-5.3-codex`) keep
 * shipping under that name even after they're marked `deprecated` in favor
 * of a newer one. A new top-effort OpenAI release resolves eligible the
 * moment `llm-zoo` ships it, with no hardcoded edit needed here.
 *
 * A pure heuristic can't fully replace a curated list, though: it both
 * over-matches models the backend doesn't actually serve and under-matches
 * ones still served despite a `deprecated` flag. {@link
 * CODEX_INELIGIBLE_EXCEPTIONS} and {@link CODEX_DEPRECATED_EXCEPTIONS} layer
 * a small, explicitly-commented set of known exceptions on top of the
 * heuristic for those two cases; everything else still resolves
 * automatically as the registry evolves.
 *
 * Requires `model.provider === ModelProvider.OPENAI` — asserted here (not
 * just by callers) since this function is exported and a future call site
 * passing a non-OpenAI `ModelConfig` must not resolve eligible just because
 * its `reasoningEffort` or id happens to match.
 *
 * `retired` (pulled from availability entirely) is checked *before* the
 * `/codex/i` naming test and has no exception carve-out, so a `-codex`-named
 * model that gets retired (e.g. a successor ships and the old one is pulled)
 * is rejected the same as any other retired model — naming alone must never
 * override a hard "no longer served" signal. `deprecated` (merely
 * superseded) is checked *after* the naming test on purpose: Codex-branded
 * releases are documented above as continuing to serve under their name even
 * once deprecated, so the naming match intentionally bypasses the
 * deprecated-exclusion for those still-live models.
 */
export function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  if (model.provider !== ModelProvider.OPENAI) return false;

  const unpinnedName = codexBackendModelId(model);
  if (CODEX_INELIGIBLE_EXCEPTIONS.has(unpinnedName)) return false;
  if (model.retired) return false;
  if (/codex/i.test(unpinnedName)) return true;
  if (model.deprecated && !CODEX_DEPRECATED_EXCEPTIONS.has(unpinnedName)) {
    return false;
  }

  return (
    model.capabilities.reasoningEffort === ReasoningEffort.XHIGH ||
    model.capabilities.reasoningEffort === ReasoningEffort.MAX
  );
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
