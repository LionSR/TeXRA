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
  if (inputPrice === undefined || outputPrice === undefined) return '';
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

/**
 * Check if a model is available via personal API keys.
 * Called only when server-side access is not available and user is in "Use My Own Keys" mode.
 */
async function checkPersonalKeyAvailability(
  config: {
    openRouterOnly?: boolean;
    openrouterFullName?: string;
    provider: string;
  },
  hasOpenRouter: boolean,
): Promise<boolean> {
  // openRouterOnly models can ONLY use OpenRouter
  if (config.openRouterOnly) {
    return hasOpenRouter;
  }

  // Providers not in API_PROVIDERS don't require keys (e.g., COPILOT)
  const provider = config.provider;
  if (!SecretManager.API_PROVIDERS.includes(provider as ApiProvider)) {
    return true;
  }

  // Check provider-specific API key
  try {
    const hasProviderKey = await SecretManager.apiKeyExists(
      provider as ApiProvider,
    );
    if (hasProviderKey) return true;

    // Fall back to OpenRouter for models that support it
    return Boolean(config.openrouterFullName && hasOpenRouter);
  } catch (error) {
    console.warn(`Failed to check API key for ${provider}:`, error);
    return false;
  }
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
 *
 * Note: Selection preservation is handled client-side via _markOptionAsSelected
 * in the webview, which uses DOMParser to add the 'selected' attribute based
 * on the current dropdown value before setting innerHTML.
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

      // Determine model availability with clear priority order
      let available = false;
      if (config.openRouterOnly) {
        // openRouterOnly models NEVER use server-side - always need OpenRouter key
        available = hasOpenRouter;
      } else if (
        hasAnyServerSideAccess &&
        serverSideKeyService.isProviderOnServer(provider) &&
        serverSideKeyService.canUseModelSync(model)
      ) {
        // Server-side relay available for this model
        available = true;
      } else if (!useIncludedAccess) {
        // Fall back to personal API keys (only when not in "Use Included Access" mode)
        available = await checkPersonalKeyAvailability(config, hasOpenRouter);
      }

      // Build option tag with data attributes
      const contextStr =
        config.contextWindow !== undefined
          ? formatContext(config.contextWindow)
          : '';
      const costStr = formatCost(config.inputPrice, config.outputPrice);

      const attrs = [
        `value="${model}"`,
        !available &&
          'data-requires-key="true" class="disabled-option disabled-model"',
        provider && `data-provider="${provider}"`,
        contextStr && `data-context="${contextStr}"`,
        costStr && `data-cost="${costStr}"`,
      ].filter(Boolean);

      // Build description from context and cost
      const descriptionParts = [
        contextStr && `Context: ${contextStr}`,
        costStr && `Cost (in/out per 1M): ${costStr}`,
      ].filter(Boolean);
      if (descriptionParts.length > 0) {
        attrs.push(`description="${descriptionParts.join(' | ')}"`);
      }

      return `<vscode-option ${attrs.join(' ')}>${model}</vscode-option>`;
    }),
  );

  return optionTags.join('\n');
}
