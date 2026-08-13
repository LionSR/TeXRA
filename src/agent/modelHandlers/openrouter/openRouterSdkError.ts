// Third-party imports
import {
  ConnectionError,
  OpenRouterError,
  RequestTimeoutError,
} from '@openrouter/sdk/models/errors';

// Local imports - support
import { matchMappedSdkError } from '../support/sdkErrorMetadata';

/**
 * Tags OpenRouter SDK errors. Transport failures get explicit connection
 * kinds from the SDK's own HTTPClientError subclasses — without these the
 * route classifier would fall back to name-regex sniffing, since the SDK's
 * `ConnectionError` doesn't match the exact class names the legacy matcher
 * knows. API errors use the single base class (`OpenRouterError`) carrying
 * the HTTP `statusCode`; the shared metadata pipeline reads that status (via
 * `detectStatusCode`) to derive the kind so it is classified and surfaced
 * like the other providers.
 */
export function tagOpenRouterSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(
    err,
    provider,
    [
      { ctor: RequestTimeoutError, kind: 'connection_timeout' },
      { ctor: ConnectionError, kind: 'connection' },
    ],
    OpenRouterError,
  );
}
