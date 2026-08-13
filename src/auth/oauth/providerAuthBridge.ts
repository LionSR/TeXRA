/**
 * Bridge between provider-specific auth errors and the shared
 * {@link SubscriptionOAuthError} used inside the coordinator machine.
 */
import {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from './subscriptionOAuthError';
import type { SubscriptionOAuthClient } from './SubscriptionOAuthCoordinator';

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
 * Map provider-thrown auth errors into {@link SubscriptionOAuthError} for the
 * shared coordinator's refresh/fatal handling.
 */
export function wrapProviderOAuthClient(
  client: SubscriptionOAuthClient,
  ErrorType: ProviderAuthErrorCtor,
): SubscriptionOAuthClient {
  const toShared = (error: unknown): never => {
    if (error instanceof ErrorType) {
      throw new SubscriptionOAuthError(
        error.message,
        error.kind,
        error.status,
        {
          cause: error,
        },
      );
    }
    throw error;
  };
  return {
    exchangeAuthorizationCode: async (params) => {
      try {
        return await client.exchangeAuthorizationCode(params);
      } catch (error) {
        return toShared(error);
      }
    },
    refreshTokens: async (refreshToken) => {
      try {
        return await client.refreshTokens(refreshToken);
      } catch (error) {
        return toShared(error);
      }
    },
  };
}
