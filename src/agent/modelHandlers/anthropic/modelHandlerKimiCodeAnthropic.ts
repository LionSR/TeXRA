/**
 * Kimi Code models using the Anthropic-compatible endpoint.
 *
 * The model registry entries ride the Moonshot provider slot but carry a
 * Kimi Code base URL and `apiKeyProvider: 'kimiCode'`. This handler delegates
 * to the standard Anthropic SDK path and only overrides credential resolution
 * so the Kimi Code API key is used instead of the Anthropic/Moonshot key.
 */
import type { ApiProvider } from '@model/apiProviders';

import { ModelHandlerAnthropic } from './modelHandlerAnthropic';

export class ModelHandlerKimiCodeAnthropic extends ModelHandlerAnthropic {
  /**
   * Use the Kimi Code API key namespace for these registry entries, not the
   * Anthropic or Moonshot secret.
   */
  protected override async getApiKey(): Promise<string> {
    const directProvider =
      (this.config as { apiKeyProvider?: ApiProvider }).apiKeyProvider ??
      'anthropic';

    // The base ModelHandler.getApiKey rules already handle server-side keys,
    // OpenRouter, and the personal-key path. Re-route only the final personal
    // fetch so the secret lookup uses the Kimi Code key.
    if (directProvider === 'kimiCode') {
      return this.fetchApiKeyOrThrow(
        'kimiCode',
        'Missing API key for Kimi Code. Set your Kimi Code API key to continue.',
      );
    }
    return super.getApiKey();
  }
}
