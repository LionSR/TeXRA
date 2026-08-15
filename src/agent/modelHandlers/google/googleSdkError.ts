// Third-party imports
import { ApiError as GoogleApiError } from '@google/genai';

// Local imports - support
import { matchMappedSdkError } from '../support/sdkErrorMetadata';

/**
 * Tags Google GenAI SDK errors. `GoogleApiError` carries the HTTP status, which
 * the shared metadata pipeline reads (via `detectStatusCode`) to derive the kind
 * and surface it like the other providers.
 */
export function tagGoogleSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(err, provider, [], GoogleApiError);
}
