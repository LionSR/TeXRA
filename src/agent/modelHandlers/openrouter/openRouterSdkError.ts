// Third-party imports
import { OpenRouterError } from '@openrouter/sdk/models/errors';

// Local imports - support
import { matchMappedSdkError } from '../support/sdkErrorMetadata';

/**
 * Tags OpenRouter SDK errors. The OpenRouter SDK uses a single base error class
 * (`OpenRouterError`) carrying the HTTP `statusCode`, plus subclasses per status.
 * The shared metadata pipeline reads that status (via `detectStatusCode`) to
 * derive the kind so it is classified and surfaced like the other providers.
 */
export function tagOpenRouterSdkError(
  err: unknown,
  provider = 'openrouter',
): void {
  matchMappedSdkError(err, provider, [], OpenRouterError);
}
