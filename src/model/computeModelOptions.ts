// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - frontend
import { ApiProvider, SecretManager } from '@frontend/secretManager';

// Local imports - model types
import type { ModelConfig } from '@model/ModelConfig';

// Local imports - utils
import { getConfig } from '@utils/config';

// Local imports - shared schemas
import type { ModelOptionData } from '@shared/schemas';

/**
 * Get the list of visible models from user configuration.
 * This should be used to validate model selections in proposals.
 */
export function getVisibleModels(): string[] {
  return getConfig<string[]>('texra.models', []);
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

/** Format context window number for display. */
function formatContext(context: number): string {
  if (context >= 1000000) return `${(context / 1000000).toFixed(1)}M`;
  if (context >= 1000) return `${Math.round(context / 1000)}K`;
  return context.toString();
}

/** Format cost values for display. */
function formatCost(inputPrice?: number, outputPrice?: number): string {
  if (inputPrice === undefined || outputPrice === undefined) return '';
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
 * Compute model <vscode-option> tags based on available API keys.
// =============================================================================
// TYPED OPTIONS BUILDER (Lit-native)
// =============================================================================

// ModelOptionData type is imported from @shared/schemas (single source of truth)

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
  const contextStr = config.contextWindow
    ? formatContext(config.contextWindow)
    : undefined;
  const costStr =
    formatCost(config.inputPrice, config.outputPrice) || undefined;

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
