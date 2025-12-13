// Local imports - model utilities
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { getConfig } from '@utils/config';
import {
  canUseServerSideKeys,
  isProviderSupportedForServerSideKeys,
} from '@auth/serverSideKeyAccess';

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
 * When server-side keys are enabled (experimental feature for Ultra users),
 * models from supported providers are marked as available even without local keys.
 */
export async function computeModelOptions(): Promise<string> {
  const models = getConfig<string[]>('texra.models', []);
  const hasOpenRouter = await SecretManager.apiKeyExists('openRouter');

  // Check if server-side API keys are available (Ultra tier + setting enabled)
  const hasServerSideKeys = await canUseServerSideKeys();

  const optionTags = await Promise.all(
    models.map(async (model) => {
      const config = MODEL_CONFIGS[model];
      if (!config) {
        return `<vscode-option value="${model}">${model}</vscode-option>`;
      }

      const provider = config.provider;
      let available = false;

      // Check if server-side keys are available for this provider
      if (
        hasServerSideKeys &&
        isProviderSupportedForServerSideKeys(provider.toLowerCase())
      ) {
        available = true;
      }

      // Check if the provider requires an API key (only if not already available via server-side)
      if (!available && SecretManager.API_PROVIDERS.includes(provider as ApiProvider)) {
        try {
          available = await SecretManager.apiKeyExists(provider as ApiProvider);
        } catch (error) {
          console.warn(`Failed to check API key for ${provider}:`, error);
          available = false;
        }
      } else if (!available) {
        // Models from providers that don't require API keys (like copilot) are always available
        available = provider.toLowerCase() === 'copilot';
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
