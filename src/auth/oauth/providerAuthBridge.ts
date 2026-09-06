/**
 * Re-mint the shared {@link SubscriptionOAuthError} raised inside the
 * coordinator machine, and the tagged request failures of `oauthRequest.ts`,
 * as the caller's provider-specific auth error.
 */
import {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from './subscriptionOAuthError';
import type { OAuthRequestError } from './oauthRequest';

interface ProviderAuthError extends Error {
  readonly kind: SubscriptionOAuthErrorKind;
  readonly status?: number;
  readonly needsReauth: boolean;
}

export type ProviderAuthErrorCtor = new (
  message: string,
  kind: SubscriptionOAuthErrorKind,
  status?: number,
  options?: ErrorOptions,
) => ProviderAuthError;

/** Re-throw as the provider error type; leave unrelated errors untouched. */
export function rethrowAsProviderAuthError(
  error: unknown,
  ErrorType: ProviderAuthErrorCtor,
): never {
  if (error instanceof ErrorType) throw error;
  if (error instanceof SubscriptionOAuthError) {
    throw new ErrorType(error.message, error.kind, error.status, {
      cause: error,
    });
  }
  throw error;
}

/**
 * The provider's auth error for a token-grant request failure: the same
 * message, kind, and status the grant's Promise API always threw.
 */
export function providerAuthError(
  error: OAuthRequestError,
  ErrorType: ProviderAuthErrorCtor,
): ProviderAuthError {
  switch (error._tag) {
    case 'OAuthHttpError':
      return new ErrorType(error.message, error.kind, error.status);
    case 'OAuthNetworkError':
    case 'OAuthUnexpectedResponse':
      return new ErrorType(error.message, 'transient', undefined, {
        cause: error.cause,
      });
  }
}
