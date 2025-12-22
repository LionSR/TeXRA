// Local imports - model utilities
import {
  canUseServerSideKeys,
  canUseServerSideKeysForModel,
  isProviderAvailableForCurrentTier,
} from '@auth/serverSideKeyAccess';
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
 * Compute model <vscode-option> tags based on available API keys.
 * Models missing a required key receive data-requires-key="true" so the
 * webview can handle API key setup prompts and display a red ✗ indicator.
 *
 * Server-side key access is tier-based:
 * - Ultra tier: All models available via relay (if provider enabled)
 * - Max tier: Only specific cheaper models available via relay (configured remotely)
 * - Free tier: Must bring own API keys
 */
export async function computeModelOptions(): Promise<string> {
  const models = getConfig<string[]>('texra.models', []);
  const hasOpenRouter = await SecretManager.apiKeyExists('openRouter');

  // Prime the server-side keys cache (fetches tier config + enabled providers)
  // This ensures canUseServerSideKeysForModel has the data it needs
  const hasAnyServerSideAccess = await canUseServerSideKeys();

  const optionTags = await Promise.all(
    models.map(async (model) => {
      const config = MODEL_CONFIGS[model];
      if (!config) {
        return `<vscode-option value="${model}">${model}</vscode-option>`;
      }

      const provider = config.provider;
      let available = false;

      // Check if server-side keys are available for THIS SPECIFIC MODEL
      // This handles tier-based access:
      // - Ultra: all models if provider enabled
      // - Max: only models in the tier config's allowed list AND provider in tier's list
      if (
        hasAnyServerSideAccess &&
        isProviderAvailableForCurrentTier(provider)
      ) {
        // For model-specific check, we need to verify this exact model is allowed
        available = await canUseServerSideKeysForModel(model);
      }

      // Check if the provider requires an API key (only if not already available via server-side)
      if (
        !available &&
        SecretManager.API_PROVIDERS.includes(provider as ApiProvider)
      ) {
        try {
          available = await SecretManager.apiKeyExists(provider as ApiProvider);
        } catch (error) {
          console.warn(`Failed to check API key for ${provider}:`, error);
          available = false;
        }
      } else if (!available) {
        // Models from providers that don't require API keys (not in API_PROVIDERS)
        // are always available (e.g., OTHERS, COPILOT)
        available = true;
      }

      // Check OpenRouter availability only if not already available and model supports it
      if (!available && config.openrouterFullName && hasOpenRouter) {
        available = true;
      }

      // Client-side adds the ✗ indicator based on data-requires-key attribute
      const label = model;
      const requiresKeyAttr = available
        ? ''
        : ' data-requires-key="true" class="disabled-option disabled-model"';

      // Build data attributes, only including them if values are defined
      const providerAttr = provider ? ` data-provider="${provider}"` : '';
      const contextStr =
        config.contextWindow !== undefined
          ? formatContext(config.contextWindow)
          : '';
      const contextAttr = contextStr ? ` data-context="${contextStr}"` : '';
      const costStr = formatCost(config.inputPrice, config.outputPrice);
      const costAttr = costStr ? ` data-cost="${costStr}"` : '';

      // Build description for tooltip (context and cost)
      const descriptionParts: string[] = [];
      if (contextStr) descriptionParts.push(`Context: ${contextStr}`);
      if (costStr) descriptionParts.push(`Cost (in/out per 1M): ${costStr}`);
      const descriptionAttr =
        descriptionParts.length > 0
          ? ` description="${descriptionParts.join(' | ')}"`
          : '';

      return `<vscode-option value="${model}"${requiresKeyAttr}${providerAttr}${contextAttr}${costAttr}${descriptionAttr}>${label}</vscode-option>`;
    }),
  );

  return optionTags.join('\n');
}
