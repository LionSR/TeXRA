// Local imports - model utilities
import { getServerSideKeyService } from '@auth/serverKeys';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { getConfig } from '@utils/config';

/**
 * Format context window number for display
 */
function formatContext(context: number): string {
  if (context >= 1000000) return `${(context / 1000000).toFixed(1)}M`;
  if (context >= 1000) return `${Math.round(context / 1000)}K`;
  return context.toString();
}

/**
 * Format cost values for display
 */
function formatCost(inputPrice?: number, outputPrice?: number): string {
  if (
    inputPrice === null ||
    inputPrice === undefined ||
    outputPrice === null ||
    outputPrice === undefined
  ) {
    return '';
  }
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

/**
 * Check if a model is available via personal API keys.
 * Called only when server-side access is not available and user is in "Use My Own Keys" mode.
 *
 * @param config - Model configuration
 * @param hasOpenRouter - Whether user has OpenRouter API key
 * @returns Whether the model is available via personal keys
 */
async function checkPersonalKeyAvailability(
  config: { openRouterOnly?: boolean; openrouterFullName?: string; provider: string },
  hasOpenRouter: boolean,
): Promise<boolean> {
  // openRouterOnly models can ONLY use OpenRouter
  if (config.openRouterOnly) {
    return hasOpenRouter;
  }

  const provider = config.provider;

  // Check provider-specific API key
  if (SecretManager.API_PROVIDERS.includes(provider as ApiProvider)) {
    try {
      const hasProviderKey = await SecretManager.apiKeyExists(provider as ApiProvider);
      if (hasProviderKey) {
        return true;
      }
      // Check OpenRouter as fallback for models that support it
      return !!(config.openrouterFullName && hasOpenRouter);
    } catch (error) {
      console.warn(`Failed to check API key for ${provider}:`, error);
      return false;
    }
  }

  // Providers not in API_PROVIDERS don't require keys (e.g., COPILOT)
  return true;
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
 * When "Use Included Access" is enabled, only server-side availability is checked.
 * When "Use My Own Keys" is selected, personal API keys are checked as fallback.
 */
export async function computeModelOptions(): Promise<string> {
  const models = getConfig<string[]>('texra.models', []);
  const hasOpenRouter = await SecretManager.apiKeyExists('openRouter');

  // Prime the server-side keys cache (fetches tier config + enabled providers)
  // This ensures canUseServerSideKeysForModel has the data it needs
  const serverSideKeyService = getServerSideKeyService();
  const hasAnyServerSideAccess =
    await serverSideKeyService.canUseServerSideKeys();

  // Check if user wants to use included access (no personal key fallback)
  const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();

  // Build option tags for each model
  // Server-side checks are sync (caches primed above), personal key checks are async
  const optionTags = await Promise.all(
    models.map(async (model) => {
      const config = MODEL_CONFIGS[model];
      if (!config) {
        return `<vscode-option value="${model}">${model}</vscode-option>`;
      }

      const provider = config.provider;

      // Determine availability - server-side checks are sync after priming
      // Note: openRouterOnly models can't use server-side relay (they need OpenRouter API)
      const hasServerSideForModel =
        hasAnyServerSideAccess &&
        !config.openRouterOnly &&
        serverSideKeyService.isProviderOnServer(provider) &&
        serverSideKeyService.canUseModelSync(model);

      let available = hasServerSideForModel;

      // openRouterOnly models can NEVER use server-side relay - they always need OpenRouter key.
      // Allow these even in "Use Included Access" mode since included access is never possible.
      if (!available && config.openRouterOnly) {
        available = hasOpenRouter;
      }

      // For other models, only check personal keys if:
      // 1. Not available via server-side, AND
      // 2. User has NOT selected "Use Included Access" (i.e., using personal keys mode)
      if (!available && !useIncludedAccess && !config.openRouterOnly) {
        available = await checkPersonalKeyAvailability(config, hasOpenRouter);
      }

      // Build option tag with data attributes
      const requiresKeyAttr = available
        ? ''
        : ' data-requires-key="true" class="disabled-option disabled-model"';
      const providerAttr = provider ? ` data-provider="${provider}"` : '';
      const contextStr =
        config.contextWindow !== undefined
          ? formatContext(config.contextWindow)
          : '';
      const contextAttr = contextStr ? ` data-context="${contextStr}"` : '';
      const costStr = formatCost(config.inputPrice, config.outputPrice);
      const costAttr = costStr ? ` data-cost="${costStr}"` : '';

      const descriptionParts: string[] = [];
      if (contextStr) descriptionParts.push(`Context: ${contextStr}`);
      if (costStr) descriptionParts.push(`Cost (in/out per 1M): ${costStr}`);
      const descriptionAttr =
        descriptionParts.length > 0
          ? ` description="${descriptionParts.join(' | ')}"`
          : '';

      return `<vscode-option value="${model}"${requiresKeyAttr}${providerAttr}${contextAttr}${costAttr}${descriptionAttr}>${model}</vscode-option>`;
    }),
  );

  return optionTags.join('\n');
}
