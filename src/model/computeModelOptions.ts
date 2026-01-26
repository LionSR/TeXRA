// Local imports - model utilities
import { getServerSideKeyService } from '@auth/serverKeys';
import { MODEL_CONFIGS } from 'llm-zoo';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import type { ModelConfig } from '@model/ModelConfig';
import type { ModelOptionData } from '@shared/schemas';
import { getConfig } from '@utils/config';

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
 * Models missing a required key receive data-requires-key="true" so the
 * webview can handle API key setup prompts and display a red ✗ indicator.
 *
 * Server-side key access is tier-based:
 * - Ultra tier: All models available via relay (if provider enabled)
 * - Max tier: Only specific cheaper models available via relay (configured remotely)
 * - Free tier: Must bring own API keys
 *
 * Note: Selection preservation is handled client-side via _markOptionAsSelected
 * in the webview, which uses DOMParser to add the 'selected' attribute based
 * on the current dropdown value before setting innerHTML.
 */
export async function computeModelOptions(): Promise<string> {
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

  const optionTags = await Promise.all(
    models.map((model) => buildModelOption(model, availabilityCtx)),
  );

  return optionTags.join('\n');
}

/** Build a single model option tag. */
async function buildModelOption(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<string> {
  const config = MODEL_CONFIGS[model];
  if (!config) {
    return `<vscode-option value="${model}">${model}</vscode-option>`;
  }

  const available = await isModelAvailable(model, config, ctx);
  const contextStr = config.contextWindow
    ? formatContext(config.contextWindow)
    : '';
  const costStr = formatCost(config.inputPrice, config.outputPrice);

  // Build description attribute from context and cost info
  const descParts: string[] = [];
  if (contextStr) descParts.push(`Context: ${contextStr}`);
  if (costStr) descParts.push(`Cost (in/out per 1M): ${costStr}`);
  const description =
    descParts.length > 0 ? `description="${descParts.join(' | ')}"` : '';

  const attrs = [
    `value="${model}"`,
    !available &&
      'data-requires-key="true" class="disabled-option disabled-model"',
    config.provider && `data-provider="${config.provider}"`,
    contextStr && `data-context="${contextStr}"`,
    costStr && `data-cost="${costStr}"`,
    description,
  ].filter(Boolean);

  return `<vscode-option ${attrs.join(' ')}>${model}</vscode-option>`;
}

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
  const costStr = formatCost(config.inputPrice, config.outputPrice) || undefined;

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
