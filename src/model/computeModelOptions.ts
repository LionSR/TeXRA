// Third-party imports
// (none)

// Local imports - model utilities
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { getConfig } from '@utils/config';

/**
 * Compute model <option> tags based on available API keys.
 * Models without a required key are marked as disabled with a "(no key)" label.
 */
export async function computeModelOptions(): Promise<string> {
  const models = getConfig<string[]>('models', []);
  const hasOpenRouter = await SecretManager.apiKeyExists('openRouter');

  const optionTags = await Promise.all(
    models.map(async (model) => {
      const config = MODEL_CONFIGS[model];
      if (!config) {
        return `<option value="${model}">${model}</option>`;
      }

      const provider = config.provider;
      let available = false;

      // Check if the provider requires an API key
      if (SecretManager.API_PROVIDERS.includes(provider as ApiProvider)) {
        try {
          available = await SecretManager.apiKeyExists(provider as ApiProvider);
        } catch (error) {
          console.warn(`Failed to check API key for ${provider}:`, error);
          available = false;
        }
      } else {
        // Models from providers that don't require API keys (like copilot) are always available
        available = true;
      }

      // Check OpenRouter availability only if not already available and model supports it
      if (!available && config.openrouterFullName && hasOpenRouter) {
        available = true;
      }

      const label = available ? model : `${model} (no key)`;
      const disabledAttr = available ? '' : ' disabled';
      return `<option value="${model}"${disabledAttr}>${label}</option>`;
    }),
  );

  return optionTags.join('\n');
}
