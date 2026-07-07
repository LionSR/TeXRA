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
 * Known false positives: an OpenAI model the registry-derived heuristic below
 * would mark eligible (top reasoning-effort tier, live, non-`codex` name),
 * but that the Codex backend does not actually serve. `gpt-5.4-nano` is
 * API-only — routing it through `/codex/responses` fails at request time
 * instead of using the normal API-key path, so it must be excluded outright
 * rather than left for the backend to reject. Keyed on
 * {@link codexBackendModelId} (shortName, or date-unpinned fullName) so a
 * llm-zoo date-pin bump doesn't silently drop the exception.
 *
 * This is deliberately a narrow, per-id table for one-off quirks — the
 * *systematic* "Pro" tier exclusion below ({@link CODEX_PRO_VARIANT_PATTERN})
 * is kept separate since it's a naming rule, not an enumerable exception.
 */
const CODEX_INELIGIBLE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'gpt-5.4-nano',
]);

/**
 * OpenAI's "Pro" tier (e.g. `o1-pro`, `o3-pro`, `gpt-5-pro`, `gpt-5.2-pro`,
 * `gpt-5.4-pro`, `gpt-5.5-pro`) is a heavier-compute, ChatGPT/API-only
 * sibling of its base release — not a distinct Codex product. A Pro model
 * typically reports the same top reasoning-effort tier as its non-Pro
 * sibling (`gpt-5.5-pro` is `XHIGH`, same as `gpt-5.5`), so without this
 * guard the reasoning-effort-tier branch below would mark it eligible and
 * `ModelFactory` would route it to `ModelHandlerCodex`, where the backend
 * rejects it (a ChatGPT subscription entitles the account to the base model,
 * not its Pro sibling) — misrouting a request that would otherwise have
 * worked fine over the normal API-key path.
 *
 * llm-zoo's `ModelConfig` (checked at v1.12.0, the version this repo pins)
 * has no dedicated tier/variant field to key on instead. Every Pro release
 * to date follows the same `<base>-pro` id suffix, though, so this is a
 * systematic naming pattern — covering future Pro releases the moment
 * llm-zoo ships them — rather than a per-id table like
 * {@link CODEX_INELIGIBLE_EXCEPTIONS}. Matched against
 * {@link codexBackendModelId} (shortName, or date-unpinned fullName), and
 * checked unconditionally ahead of every other branch (including the
 * `/codex/i` naming test): a Pro variant must never resolve eligible
 * regardless of reasoning tier or a coincidental `codex` substring in its id.
 */
const CODEX_PRO_VARIANT_PATTERN = /-pro$/i;

/**
 * Known false negative: an OpenAI model the registry marks merely
 * `deprecated` (superseded by a newer release, not pulled) that the Codex
 * backend still actually serves. The old hand-maintained fullName allowlist
 * this heuristic replaced still routed `gpt-5.4` and `gpt-5.4-mini` through
 * the ChatGPT subscription after `gpt-5.5` shipped; treating every
 * `deprecated` model as ineligible would regress that. `deprecated` still
 * disqualifies by default — only these explicit, known-still-served
 * exceptions bypass it. Keyed on {@link codexBackendModelId}.
 *
 * `gpt-5.4-mini` is included here even though it isn't `deprecated` in the
 * live llm-zoo registry as of this writing (only `gpt-5.4` is) — the old
 * allowlist's test coverage explicitly asserted `gpt-5.4-mini` as eligible,
 * so this exception is added defensively now rather than waiting for it to
 * flip to `deprecated` upstream and silently regress. It's a no-op today
 * (the `deprecated` branch below never triggers for it) and becomes load
 * bearing the moment llm-zoo marks it deprecated.
 *
 * Cross-checked against every entry of the original hardcoded
 * `CODEX_SUBSCRIPTION_MODEL_FULLNAMES` allowlist this heuristic replaced:
 * `gpt-5.5` and `gpt-5.4-mini` (not deprecated) and `gpt-5.3-codex` /
 * `gpt-5.2-codex` (deprecated, but bypassed by the `/codex/i` naming branch
 * regardless of this table) all resolve eligible without needing an entry
 * here. `gpt-5.3-codex-spark` no longer exists in the llm-zoo v1.12.0
 * registry under any id, so there is nothing to reconcile for it.
 */
const CODEX_DEPRECATED_EXCEPTIONS: ReadonlySet<string> = new Set([
  'gpt-5.4',
  'gpt-5.4-mini',
]);

/**
 * Whether `model` is eligible to route through the ChatGPT-subscription
 * (Codex) backend.
 *
 * ## The general rule (registry-derived heuristic)
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
 * Requires `model.provider === ModelProvider.OPENAI` — asserted here (not
 * just by callers) since this function is exported and a future call site
 * passing a non-OpenAI `ModelConfig` must not resolve eligible just because
 * its `reasoningEffort` or id happens to match.
 *
 * ## The exception tables (today's known quirks)
 *
 * A pure heuristic can't fully replace a curated list: it both over-matches
 * models the backend doesn't actually serve and under-matches ones still
 * served despite a `deprecated` flag. Three explicitly-commented tables
 * layer known exceptions on top of the heuristic, each checked and cross-
 * referenced against the original hand-maintained allowlist this heuristic
 * replaced (see each table's own doc comment for the reconciliation):
 *
 * - {@link CODEX_INELIGIBLE_EXCEPTIONS} — per-id false positives that match
 *   the heuristic but aren't Codex-served (e.g. `gpt-5.4-nano`, API-only).
 * - {@link CODEX_PRO_VARIANT_PATTERN} — a systematic (not per-id) false-
 *   positive exclusion for the "Pro" tier, which shares its sibling's
 *   reasoning-effort tier but isn't served by Codex.
 * - {@link CODEX_DEPRECATED_EXCEPTIONS} — per-id false negatives: models the
 *   registry marks `deprecated` that Codex still actually serves (e.g.
 *   `gpt-5.4`, `gpt-5.4-mini`).
 *
 * Everything else still resolves automatically as the registry evolves.
 *
 * ## Branch ordering
 *
 * `CODEX_INELIGIBLE_EXCEPTIONS` and `CODEX_PRO_VARIANT_PATTERN` are checked
 * first and unconditionally — a known-bad or Pro-tier id must never resolve
 * eligible no matter what any later branch would say. `retired` (pulled from
 * availability entirely) is checked next, *before* the `/codex/i` naming
 * test, and has no exception carve-out, so a `-codex`-named model that gets
 * retired (e.g. a successor ships and the old one is pulled) is rejected the
 * same as any other retired model — naming alone must never override a hard
 * "no longer served" signal. `deprecated` (merely superseded) is checked
 * *after* the naming test on purpose: Codex-branded releases are documented
 * above as continuing to serve under their name even once deprecated, so the
 * naming match intentionally bypasses the deprecated-exclusion for those
 * still-live models.
 */
export function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  if (model.provider !== ModelProvider.OPENAI) return false;

  const unpinnedName = codexBackendModelId(model);
  if (CODEX_INELIGIBLE_EXCEPTIONS.has(unpinnedName)) return false;
  if (CODEX_PRO_VARIANT_PATTERN.test(unpinnedName)) return false;
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
