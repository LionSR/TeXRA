// Third-party imports
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - frontend
import { GlobalStateKey, globalSM } from '@common/state';
import { ApiProvider, SecretManager } from '@frontend/secretManager';

// Local imports - shared schemas
import type { ModelOptionData } from '@shared/schemas';

/**
 * Default models that should be present in every user's model list.
 * Update this list and increment MODEL_LIST_VERSION below when adding new models.
 */
export const DEFAULT_MODELS = [
  'gemini31p',
  'gemini3f',
  'sonnet46T',
  'opus46T',
  'gpt54',
  'gpt54pro',
  'gpt53codex',
  'gpt41',
  'deepseekT',
  'kimi25T',
  'grok4',
];

/**
 * Version number for the default model list.
 * Increment this when adding or removing models to force existing users
 * to get the updated defaults. A simple integer avoids hash-collision risks
 * and doesn't trigger on harmless reordering.
 */
export const MODEL_LIST_VERSION = 7;

/**
 * Get the list of visible models from extension global state.
 * This should be used to validate model selections in proposals.
 */
export function getVisibleModels(): string[] {
  return globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS);
}

/**
 * Resolve a model to a valid visible model.
 * Returns the model as-is if visible, falls back to the first visible model,
 * or allows any model when none are configured (consistent with agent filterVisible).
 */
export function resolveVisibleModel(model: string): string {
  const visibleModels = getVisibleModels();
  if (visibleModels.length === 0) return model;
  if (visibleModels.includes(model)) return model;
  return visibleModels[0];
}

/**
 * Human-friendly display names for models whose IDs are not self-explanatory.
 * Used as the `label` in model dropdowns so users can identify models at a glance.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  gpt53codex: 'GPT-5.3 Codex',
  gpt54pro: 'GPT-5.4 Pro',
  gpt54: 'GPT-5.4',
  'gpt5-': 'GPT-5 Mini',
  gpt41: 'GPT-4.1',
  sonnet46T: 'Sonnet 4.6 (Thinking)',
  opus46T: 'Opus 4.6 (Thinking)',
  gemini31p: 'Gemini 3.1 Pro',
  gemini3f: 'Gemini 3.0 Flash',
  deepseekT: 'DeepSeek (Thinking)',
  kimi25T: 'Kimi K2.5 (Thinking)',
  grok4: 'Grok 4',
};

/** Context window formatting thresholds */
const MILLION = 1_000_000;
const THOUSAND = 1_000;

/** Format context window number for display. */
export function formatContext(context: number | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context >= MILLION) return `${(context / MILLION).toFixed(1)}M`;
  if (context >= THOUSAND) return `${Math.round(context / THOUSAND)}K`;
  return context.toString();
}

/** Format cost values for display. */
export function formatCost(
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): string | undefined {
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

/** Check if a model is available via personal API keys. */
async function hasPersonalKeyForModel(
  config: ModelConfig,
  hasOpenRouter: boolean,
): Promise<boolean> {
  if (config.openRouterOnly) return hasOpenRouter;
  if (!SecretManager.API_PROVIDERS.includes(config.provider as ApiProvider)) {
    return true;
  }

  try {
    return (
      (await SecretManager.apiKeyExists(config.provider as ApiProvider)) ||
      Boolean(config.openrouterFullName && hasOpenRouter)
    );
  } catch {
    return false;
  }
}

interface ModelAvailabilityContext {
  hasOpenRouter: boolean;
  hasServerAccess: boolean;
  useIncludedAccess: boolean;
  serverSideKeyService: ReturnType<typeof getServerSideKeyService>;
}

/** Determine if a model is available based on access mode and keys. */
async function isModelAvailable(
  model: string,
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): Promise<boolean> {
  // openRouterOnly models always need OpenRouter key
  if (config.openRouterOnly) return ctx.hasOpenRouter;

  // Check server-side relay availability
  if (
    ctx.hasServerAccess &&
    ctx.serverSideKeyService.isProviderOnServer(config.provider) &&
    ctx.serverSideKeyService.canUseModelSync(model)
  ) {
    return true;
  }

  // Fall back to personal API keys when:
  // - User explicitly chose "Use My Own Keys", OR
  // - User has default "Use Included Access" but isn't actually authenticated with server access
  //   (avoids showing all models as disabled for unauthenticated users)
  if (!ctx.useIncludedAccess || !ctx.hasServerAccess) {
    return hasPersonalKeyForModel(config, ctx.hasOpenRouter);
  }

  return false;
}

/** Build typed model option data for a single model. */
async function buildModelOptionData(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<ModelOptionData> {
  const config = MODEL_CONFIGS[model];
  if (!config) {
    return { value: model, label: MODEL_DISPLAY_NAMES[model] ?? model };
  }

  const available = await isModelAvailable(model, config, ctx);
  return {
    value: model,
    label: MODEL_DISPLAY_NAMES[model] ?? model,
    provider: config.provider,
    context: formatContext(config.contextWindow),
    cost: formatCost(config.inputPrice, config.outputPrice),
    requiresKey: !available,
    disabled: !available,
  };
}

/**
 * Build basic model options from static config only (synchronous).
 * Includes provider, context, and cost metadata but skips async
 * availability checks. All models are shown as enabled.
 */
export function buildBasicModelOptionsData(): ModelOptionData[] {
  return getVisibleModels().map((model) => {
    const config = MODEL_CONFIGS[model];
    if (!config) return { value: model, label: MODEL_DISPLAY_NAMES[model] ?? model };
    return {
      value: model,
      label: MODEL_DISPLAY_NAMES[model] ?? model,
      provider: config.provider,
      context: formatContext(config.contextWindow),
      cost: formatCost(config.inputPrice, config.outputPrice),
    };
  });
}

/**
 * TTL-based cache for computeModelOptionsData.
 * Avoids redundant async work (SecretManager + server-side key checks)
 * when multiple callers request model options in quick succession.
 *
 * State is split into resolved data vs in-flight promise to avoid
 * sentinel values (like `data: []`) that could leak to callers.
 */
const MODEL_OPTIONS_CACHE_TTL_MS = 5_000;
let _resolved: { data: ModelOptionData[]; expiry: number } | null = null;
let _pending: Promise<ModelOptionData[]> | null = null;

/** Invalidate the shared model options cache (e.g. after key or model-list changes). */
export function invalidateModelOptionsCache(): void {
  _resolved = null;
  _pending = null;
}

/** Compute typed model options data for Lit-native rendering. */
export async function computeModelOptionsData(): Promise<ModelOptionData[]> {
  // Return cached result if still valid.
  if (_resolved && Date.now() < _resolved.expiry) {
    return _resolved.data;
  }

  // Dedup concurrent callers — share the same in-flight promise.
  if (_pending) {
    return _pending;
  }

  const thisRequest = computeModelOptionsDataUncached();
  _pending = thisRequest;

  try {
    const data = await thisRequest;
    // Only populate cache if no invalidation occurred while we were awaiting.
    // invalidateModelOptionsCache() sets _pending = null, so comparing against
    // thisRequest detects concurrent invalidation.
    if (_pending === thisRequest) {
      _resolved = { data, expiry: Date.now() + MODEL_OPTIONS_CACHE_TTL_MS };
    }
    return data;
  } finally {
    if (_pending === thisRequest) {
      _pending = null;
    }
  }
}

async function computeModelOptionsDataUncached(): Promise<ModelOptionData[]> {
  const models = getVisibleModels();

  const serverSideKeyService = getServerSideKeyService();
  const [hasOpenRouter, hasServerAccess] = await Promise.all([
    SecretManager.apiKeyExists('openRouter'),
    serverSideKeyService.canUseServerSideKeys(),
  ]);

  const availabilityCtx: ModelAvailabilityContext = {
    hasOpenRouter,
    hasServerAccess,
    useIncludedAccess: serverSideKeyService.getUseIncludedModelAccess(),
    serverSideKeyService,
  };

  return Promise.all(
    models.map((model) => buildModelOptionData(model, availabilityCtx)),
  );
}
