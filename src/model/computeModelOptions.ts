// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - frontend
import { ApiProvider, SecretManager } from '@frontend/secretManager';

// Local imports - model types
import type { ModelConfig } from '@model/ModelConfig';

// Local imports - state
import { GlobalStateKey, globalSM } from '@common/state';

// Local imports - shared schemas
import type { ModelOptionData } from '@shared/schemas';

/**
 * Default models that should be present in every user's model list.
 * Update this list and increment MODEL_LIST_VERSION in setup.ts when adding new models.
 */
export const DEFAULT_MODELS = [
  'gemini3p',
  'gemini3f',
  'sonnet45T',
  'sonnet45',
  'opus46T',
  'opus46',
  'gpt52',
  'gpt52pro',
  'gpt41',
  'deepseekT',
  'kimi25T',
  'kimi25',
  'qwen3max',
  'grok4',
];

/**
 * Get the list of visible models from extension global state.
 * This should be used to validate model selections in proposals.
 */
export function getVisibleModels(): string[] {
  return globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS);
}

/**
 * Resolve a model to a valid visible model.
 * Returns the model if valid, or falls back to the first visible model.
 * Consistent with filterVisible for agents: if no models configured, allows any model.
 *
 * @returns The resolved model name
 * @throws Error if models are configured but none are available (shouldn't happen in practice)
 */
export function resolveVisibleModel(model: string): string {
  const visibleModels = getVisibleModels();

  // If no models configured, allow any model (consistent with agent filterVisible)
  if (visibleModels.length === 0) return model;

  // If model is in visible list, use it
  if (visibleModels.includes(model)) return model;

  // Fall back to first visible model
  return visibleModels[0];
}

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
  // openRouterOnly models require OpenRouter
  if (config.openRouterOnly) return hasOpenRouter;

  // Providers not in API_PROVIDERS don't require keys (e.g., COPILOT)
  if (!SecretManager.API_PROVIDERS.includes(config.provider as ApiProvider)) {
    return true;
  }

  // Check provider-specific API key or OpenRouter fallback
  try {
    if (await SecretManager.apiKeyExists(config.provider as ApiProvider)) {
      return true;
    }
    return Boolean(config.openrouterFullName && hasOpenRouter);
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

  // Fall back to personal API keys (only when not in "Use Included Access" mode)
  if (!ctx.useIncludedAccess) {
    return hasPersonalKeyForModel(config, ctx.hasOpenRouter);
  }

  return false;
}

/**
 * Build typed model option data for a single model.
 */
async function buildModelOptionData(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<ModelOptionData> {
  const config = MODEL_CONFIGS[model];
  if (!config) {
    return { value: model, label: model };
  }

  const available = await isModelAvailable(model, config, ctx);
  const contextStr = formatContext(config.contextWindow);
  const costStr = formatCost(config.inputPrice, config.outputPrice);

  return {
    value: model,
    label: model,
    provider: config.provider,
    context: contextStr,
    cost: costStr,
    requiresKey: !available,
    disabled: !available,
  };
}

/**
 * Compute typed model options data for Lit-native rendering.
 * Returns structured data instead of HTML strings.
 */
export async function computeModelOptionsData(): Promise<ModelOptionData[]> {
  const models = getVisibleModels();

  // Prime caches for availability checks
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
