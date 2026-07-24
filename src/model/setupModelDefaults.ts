import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  getRuntimeModelConfig,
  staticModelConfigEntries,
} from './runtimeModelRegistry';
import { resolveModelSource } from './openRouterRouting';
import { isCodexSubscriptionEligible } from './providerCapabilities';

/**
 * Curated setup-probe model per provider — a well-known model used to verify
 * a provider's credential during onboarding. This table is a *preference*,
 * not the source of truth for whether that model is still servable: a
 * provider can retire the pinned model at any time (this has already
 * happened live for `xai: 'grok4'`), which would otherwise make the setup
 * assistant silently probe a dead model forever. {@link resolveWithPreferred}
 * below validates each preference through the runtime model registry and
 * substitutes a still-usable model for that provider when the pin has gone
 * stale, so {@link SETUP_MODEL_BY_PROVIDER} always resolves to a servable
 * model without needing this table hand-updated on every retirement.
 */
const PREFERRED_SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'opus5T',
  openai: 'gpt55',
  google: 'gemini31p',
  deepseek: 'deepseekproT',
  openRouter: 'sonnet46T',
  xai: 'grok4',
  moonshot: 'kimi25T',
  kimiCode: 'kimiCoding',
  dashscope: 'qwen3max',
  minimax: 'minimax01',
  glm: 'glm5',
  meta: 'musespark11',
};

/**
 * Model source each setup credential may probe. `openRouter` has no static
 * source of its own, so its preferred Anthropic model falls back within that
 * family; managed direct services such as Kimi Code retain their own source.
 */
const FALLBACK_MODEL_SOURCE: Readonly<Record<string, string>> = {
  anthropic: ModelProvider.ANTHROPIC,
  openai: ModelProvider.OPENAI,
  google: ModelProvider.GOOGLE,
  deepseek: ModelProvider.DEEPSEEK,
  openRouter: ModelProvider.ANTHROPIC,
  xai: ModelProvider.XAI,
  moonshot: ModelProvider.MOONSHOT,
  kimiCode: 'kimiCode',
  dashscope: ModelProvider.DASHSCOPE,
  minimax: ModelProvider.MINIMAX,
  glm: ModelProvider.GLM,
  meta: ModelProvider.META,
};

/** Whether `config` is safe to hand to the setup assistant for `setupProvider`. */
function isUsableSetupModel(
  config: ModelConfig | undefined,
  setupProvider: string,
): config is ModelConfig {
  if (!config || config.retired) return false;
  // A direct-API setup probe needs a model reachable outside OpenRouter.
  if (config.openRouterOnly) return false;
  // CHATGPT_SETUP_MODEL feeds isCodexSubscriptionActive, which only accepts
  // Codex-eligible model ids — keep the openai pick constrained so a
  // fallback swap can't silently break ChatGPT-subscription setup.
  if (setupProvider === 'openai') {
    return isCodexSubscriptionEligible(config);
  }
  return true;
}

/**
 * A still-usable model for `setupProvider`, preferring a non-deprecated one.
 * Static registry order is not a recency contract, so this is "some live
 * model," not necessarily the newest release.
 */
function fallbackSetupModel(setupProvider: string): string | undefined {
  const modelSource = FALLBACK_MODEL_SOURCE[setupProvider];
  if (!modelSource) return undefined;

  const candidates = staticModelConfigEntries()
    .map(([, config]) => config)
    .filter(
      (config) =>
        resolveModelSource(config) === modelSource &&
        isUsableSetupModel(config, setupProvider),
    );
  const preferNonDeprecated = candidates.find((config) => !config.deprecated);
  return (preferNonDeprecated ?? candidates[0])?.name;
}

/**
 * Resolve `setupProvider`'s `preferred` pick if it is still live, otherwise a
 * usable fallback model this provider currently has in the registry. Takes
 * `preferred` as a parameter (rather than looking it up) so callers that
 * already know it holds a real value — like {@link SETUP_MODEL_BY_PROVIDER}
 * below, iterating its own preference table — get back a plain `string`
 * with no unresolved-provider case to handle.
 */
function resolveWithPreferred(
  setupProvider: string,
  preferred: string,
): string {
  if (isUsableSetupModel(getRuntimeModelConfig(preferred), setupProvider)) {
    return preferred;
  }
  return fallbackSetupModel(setupProvider) ?? preferred;
}

/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential. Kept with model metadata so hosts do not
 * each define their own setup routing truth. Resolved once at module load —
 * the static model catalog is fixed per process — via
 * {@link resolveWithPreferred}, so
 * a provider's curated pick going stale (retired or OpenRouter-only) degrades
 * to a live fallback instead of hard-failing the setup probe.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(PREFERRED_SETUP_MODEL_BY_PROVIDER).map(
      ([provider, preferred]) => [
        provider,
        resolveWithPreferred(provider, preferred),
      ],
    ),
  );

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;
