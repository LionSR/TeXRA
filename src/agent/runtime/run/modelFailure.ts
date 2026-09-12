/**
 * The runtime's reading of a failed model attempt. The package raises one
 * `ModelError` over the provider SDK's own failure; the retry policy, the
 * route gate and the manual-retry prompt keep reading the runtime's own
 * taxonomy (D3), computed here from the SDK cause the package carried.
 */
import { isContextWindowError } from '@common/errors/sdkError/errorPatterns';
import {
  attachContextWindowError,
  attachProviderError,
  attachSdkUsageRoute,
} from '@common/errors/sdkError/errorMetadata';
import {
  classifyModelRouteFailure,
  isProviderErrorAutoRetryable,
  normalizeProviderError,
  type ModelRouteVerdict,
} from '@common/errors/sdkError/providerErrorFormat';
import { ModelError } from '@llm/turn';
import {
  toRetryErrorInfo,
  type ProviderError,
  type RetryErrorInfo,
  type UsageRoute,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

export interface ModelFailure {
  /** The error the runtime policies read: the SDK cause when there is one. */
  readonly error: Error;
  readonly formatted: ProviderError;
  readonly info: RetryErrorInfo;
  readonly autoRetryable: boolean;
  readonly verdict: ModelRouteVerdict;
}

/** True when the package reports the input itself exceeded the window. */
function isPackageContextOverflow(error: ModelError): boolean {
  return (
    error.kind === 'invalid-request' &&
    (isContextWindowError(error) ||
      /context.?(window|length)|too many tokens|maximum context/i.test(
        error.message,
      ))
  );
}

/**
 * Reads a failed attempt. `usageRoute` is the credential route the attempt was
 * bound to: SuperGrok and Kimi Code share their API-key host, so the bound
 * route is the only signal that separates a subscription quota failure from a
 * key rate limit, and the subscription detectors read it back off the error.
 * `partialText` is the tail of the text the attempt had already streamed: the
 * one producer of the field the retry surface shows, now that the loop rather
 * than a provider handler is what watches the stream.
 */
export function classifyModelFailure(
  cause: unknown,
  usageRoute?: UsageRoute,
  partialText?: string,
): ModelFailure {
  const packageError = cause instanceof ModelError ? cause : null;
  const error =
    packageError !== null && packageError.cause instanceof Error
      ? packageError.cause
      : ensureError(cause);
  if (packageError !== null && isPackageContextOverflow(packageError)) {
    attachContextWindowError(error);
  }
  if (usageRoute !== undefined) attachSdkUsageRoute(error, usageRoute);
  const formatted = normalizeProviderError(error);
  const withPackageFacts: ProviderError = {
    ...formatted,
    message:
      formatted.message.trim() !== ''
        ? formatted.message
        : (packageError?.message ?? error.message),
    ...(packageError?.status !== undefined && formatted.statusCode === undefined
      ? { statusCode: packageError.status }
      : {}),
    ...(packageError?.requestId !== undefined &&
    formatted.requestId === undefined
      ? { requestId: packageError.requestId }
      : {}),
    ...(partialText !== undefined && partialText !== '' ? { partialText } : {}),
  };
  // Seed the runtime's error cache so every later reader (the run lifecycle's
  // terminal classification included) recovers this same shape.
  attachProviderError(error, withPackageFacts);
  const autoRetryable =
    packageError?.kind === 'invalid-request' ||
    packageError?.kind === 'unsupported' ||
    packageError?.kind === 'authentication'
      ? false
      : isProviderErrorAutoRetryable(error);
  return {
    error,
    formatted: withPackageFacts,
    info: toRetryErrorInfo(withPackageFacts),
    autoRetryable,
    verdict: classifyModelRouteFailure(error),
  };
}
