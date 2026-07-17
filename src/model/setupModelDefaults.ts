import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import {
  getRuntimeModelConfig,
  runtimeModelConfigEntries,
} from './runtimeModelRegistry';
import { isCodexSubscriptionEligible } from './providerCapabilities';

/**
 * Curated setup-probe model per provider — a well-known model used to verify
 * a provider's credential during onboarding. This table is a *preference*,
 * not the source of truth for whether that model is still servable: a
 * provider can retire the pinned model at any time (this has already
 * happened live for `xai: 'grok4'`), which would otherwise make the setup
 * assistant silently probe a dead model forever. `resolveSetupModel` below
 * validates each preference against the live `MODEL_CONFIGS` registry and
 * substitutes a still-usable model for that provider when the pin has gone
 * stale, so {@link SETUP_MODEL_BY_PROVIDER} always resolves to a servable
 * model without needing this table hand-updated on every retirement.
 */
const PREFERRED_SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'opus48T',
  openai: 'gpt55',
  google: 'gemini31p',
  deepseek: 'deepseekproT',
  openRouter: 'sonnet46T',
  xai: 'grok4',
  moonshot: 'kimi25T',
  kimiCode: 'kimiCodeK3',
  dashscope: 'qwen3max',
  minimax: 'minimax01',
  glm: 'glm5',
  meta: 'musespark11',
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

/** Credential namespace a fallback candidate would use for this setup flow. */
function setupCredentialProvider(
  config: ModelConfig,
  setupProvider: string,
): string | undefined {
  if (setupProvider === 'openRouter') {
    return config.provider === 'anthropic' ? 'openRouter' : undefined;
  }
  return (
    (config as { readonly apiKeyProvider?: string }).apiKeyProvider ??
    config.provider
  );
}

/**
 * A still-usable model for `setupProvider`, preferring a non-deprecated one.
 * `MODEL_CONFIGS` iteration order is llm-zoo's own (not a recency contract),
 * so this is "some live model," not necessarily the newest release.
 */
function fallbackSetupModel(setupProvider: string): string | undefined {
  const candidates = runtimeModelConfigEntries()
    .map(([, config]) => config)
    .filter((config) => {
      // OpenRouter has no direct provider identity; retain its curated
      // Anthropic fallback pool while all direct-key providers match the
      // credential namespace the model will actually use.
      return (
        setupCredentialProvider(config, setupProvider) === setupProvider &&
        isUsableSetupModel(config, setupProvider)
      );
    });
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
  if (
    isUsableSetupModel(
      getRuntimeModelConfig(preferred) ?? MODEL_CONFIGS[preferred],
      setupProvider,
    )
  ) {
    return preferred;
  }
  return fallbackSetupModel(setupProvider) ?? preferred;
}

/**
 * Resolve the model the setup assistant should probe for `setupProvider`:
 * the curated preference above when it is still live, otherwise a usable
 * model this provider currently has in the registry. Returns `undefined`
 * for a `setupProvider` outside {@link PREFERRED_SETUP_MODEL_BY_PROVIDER} —
 * callers that already hold a known provider key get a plain `string` from
 * {@link SETUP_MODEL_BY_PROVIDER} instead.
 */
export function resolveSetupModel(setupProvider: string): string | undefined {
  const preferred = PREFERRED_SETUP_MODEL_BY_PROVIDER[setupProvider];
  return preferred === undefined
    ? undefined
    : resolveWithPreferred(setupProvider, preferred);
}

/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential. Kept with model metadata so hosts do not
 * each define their own setup routing truth. Resolved once at module load —
 * `MODEL_CONFIGS` is static per process — via {@link resolveWithPreferred}, so
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
