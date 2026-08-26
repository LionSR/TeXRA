/**
 * Re-mint the shared {@link SubscriptionOAuthError} raised inside the
 * coordinator machine as the caller's provider-specific auth error.
 */
import {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from './subscriptionOAuthError';

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
