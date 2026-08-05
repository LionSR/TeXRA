import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  getRuntimeModelConfig,
  staticModelConfigEntries,
} from './runtimeModelRegistry';
import { resolveModelSource } from './openRouterRouting';
import { isCodexSubscriptionEligible } from './providerCapabilities';

interface SetupProviderDefaults {
  /**
   * Curated setup-probe model — a well-known model used to verify this
   * provider's credential during onboarding. A *preference*, not the source
   * of truth for whether that model is still servable: a provider can retire
   * the pinned model at any time (this has already happened live for
   * `xai: 'grok4'`), which would otherwise make the setup assistant silently
   * probe a dead model forever.
   */
  readonly preferredModel: string;
  /**
   * Model source this credential may probe when the pin has gone stale.
   * `openRouter` has no static source of its own, so its preferred Anthropic
   * model falls back within that family; managed direct services such as Kimi
   * Code retain their own source.
   */
  readonly fallbackSource: string;
}

/**
 * Per-provider setup defaults. {@link SETUP_MODEL_BY_PROVIDER} below validates
 * each preferred pick through the runtime model registry and substitutes a
 * still-usable model from `fallbackSource` when the pin has gone stale, so it
 * always resolves to a servable model without needing this table hand-updated
 * on every retirement.
 */
const SETUP_PROVIDER_DEFAULTS: Readonly<Record<string, SetupProviderDefaults>> =
  {
    anthropic: {
      preferredModel: 'opus5T',
      fallbackSource: ModelProvider.ANTHROPIC,
    },
    openai: { preferredModel: 'gpt55', fallbackSource: ModelProvider.OPENAI },
    google: {
      preferredModel: 'gemini31p',
      fallbackSource: ModelProvider.GOOGLE,
    },
    deepseek: {
      preferredModel: 'deepseekproT',
      fallbackSource: ModelProvider.DEEPSEEK,
    },
    openRouter: {
      preferredModel: 'sonnet46T',
      fallbackSource: ModelProvider.ANTHROPIC,
    },
    xai: { preferredModel: 'grok45', fallbackSource: ModelProvider.XAI },
    moonshot: {
      preferredModel: 'kimi25T',
      fallbackSource: ModelProvider.MOONSHOT,
    },
    kimiCode: { preferredModel: 'kimiCoding', fallbackSource: 'kimiCode' },
    dashscope: {
      preferredModel: 'qwen3max',
      fallbackSource: ModelProvider.DASHSCOPE,
    },
    minimax: {
      preferredModel: 'minimax01',
      fallbackSource: ModelProvider.MINIMAX,
    },
    glm: { preferredModel: 'glm5', fallbackSource: ModelProvider.GLM },
    meta: { preferredModel: 'musespark11', fallbackSource: ModelProvider.META },
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
  const modelSource = SETUP_PROVIDER_DEFAULTS[setupProvider]?.fallbackSource;
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
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential. Kept with model metadata so hosts do not
 * each define their own setup routing truth. Resolved once at module load —
 * the static model catalog is fixed per process — keeping each curated pick
 * that is still live and degrading a stale one (retired or OpenRouter-only)
 * to a live fallback instead of hard-failing the setup probe.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(SETUP_PROVIDER_DEFAULTS).map(
      ([provider, { preferredModel }]) => [
        provider,
        isUsableSetupModel(getRuntimeModelConfig(preferredModel), provider)
          ? preferredModel
          : (fallbackSetupModel(provider) ?? preferredModel),
      ],
    ),
  );

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;
