// Third-party imports
import { OpenRouterError } from '@openrouter/sdk/models/errors';

// Local imports - common errors
import { sdkErrorKindFromStatusCode } from '@common/errors/sdkErrorUtils';

// Local imports - support
import { tagSdkError } from '../support/sdkErrorMetadata';

/**
 * Tags OpenRouter SDK errors. The OpenRouter SDK uses a single base error class
 * (`OpenRouterError`) carrying the HTTP `statusCode`, plus subclasses per status.
 * Derive the kind from the status code so the shared metadata pipeline can
 * classify and surface them like the other providers.
 */
export function tagOpenRouterSdkError(
  err: unknown,
  provider = 'openrouter',
): void {
  if (err instanceof OpenRouterError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.statusCode),
      err.statusCode,
    );
  }
}
