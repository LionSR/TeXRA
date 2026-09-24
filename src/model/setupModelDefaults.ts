import { MODEL_PROVIDER_PLUGINS } from '@shared/constants/modelProviderPlugins';

/**
 * Provider-specific models the setup assistant can use when that provider is
 * the only known usable credential: each provider plugin's `setupModel`, one
 * well-known probe model per provider, so hosts do not each define their own
 * setup routing truth.
 */
export const SETUP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> =
  Object.fromEntries(
    MODEL_PROVIDER_PLUGINS.flatMap(({ id, setupModel }) =>
      setupModel === undefined ? [] : [[id, setupModel]],
    ),
  );

/** Codex-eligible setup model used to prove ChatGPT subscription access. */
export const CHATGPT_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.openai;

/** xAI-eligible setup model used to prove Grok subscription access. */
export const XAI_SETUP_MODEL = SETUP_MODEL_BY_PROVIDER.xai;
