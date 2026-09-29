/**
 * The runtime's reading of a failed model attempt. The package raises one
 * `ModelError` over the provider SDK's own failure. Its kind, status, request
 * id and `retry-after` are the classification; the SDK cause it carries is
 * read only for what the package cannot know: the reply body (quota and
 * credit exhaustion, a model-scoped limit, an overflowed window), which the
 * runtime turns into the retry policy, the route verdict and the manual-retry
 * prompt.
 */
import { StatusCodes } from 'http-status-codes';
import { ModelError } from '@texra-ai/llm/turn';

import { isContextWindowError } from '@common/errors/sdkError/errorPatterns';
import {
  attachContextWindowError,
  attachProviderError,
  attachSdkUsageRoute,
} from '@common/errors/sdkError/errorMetadata';
import {
  getErrorClassNames,
  isModelScopedRateLimitBody,
} from '@common/errors/sdkError/errorInspection';
import { causeChain } from '@common/errors/errorPredicates';
import {
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import {
  getExhaustionReason,
  toRetryErrorInfo,
  type ExhaustionReason,
  type ProviderError,
  type RetryErrorInfo,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

import type { BoundModel } from './modelBinding';

/**
 * What one failed model call proves about the recovery routes it ran under.
 * Every route asks a different question of the same failure — the shared wire
 * route and the model-specific limit scope — so the call site classifies once
 * and reads the verdict.
 */
export interface ModelRouteVerdict {
  /** The scope that owns the limit. Defined only for a 429. */
  readonly rateLimitScope: 'model' | 'wire' | undefined;
  /** Credential exhaustion (subscription quota, upstream credit). */
  readonly exhaustionReason: ExhaustionReason | undefined;
  /**
   * The failure carries evidence about a shared wire route (provider +
   * credential + endpoint): a transport failure with network evidence, a
   * 5xx/408 server failure, or a rate limit without an explicit model scope —
   * that one uses its own recovery scope. A 409, retryable per request, stays
   * node-local: a conflict does not imply the route is unhealthy.
   */
  readonly wireRouteFailure: boolean;
  /** The provider's own `retry-after` guidance, as the package read it. */
  readonly retryAfterMs: number | undefined;
}

export interface ModelFailure {
  /** The error the runtime policies read: the SDK cause when there is one. */
  readonly error: Error;
  readonly formatted: ProviderError;
  readonly info: RetryErrorInfo;
  readonly autoRetryable: boolean;
  readonly verdict: ModelRouteVerdict;
  /** A chained request's stored response is missing or past retention. */
  readonly storedResponseGone: boolean;
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

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The package labels every non-HTTP, non-parse failure `transport`, including
 * local ones (a stale persistent socket, a bug in stream handling). Only a
 * failure whose cause chain shows the network itself (a code in
 * `NETWORK_ERROR_CODES`, an undici `UND_ERR_INFO` timeout, an SDK connection
 * or timeout class, a bare `fetch failed`) is evidence about the shared route;
 * the rest is the caller's own to retry.
 */
function hasNetworkEvidence(error: ModelError): boolean {
  return causeChain(error.cause).some((link) => {
    const { code, message } = link as { code?: unknown; message?: unknown };
    return (
      (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) ||
      (code === 'UND_ERR_INFO' &&
        typeof message === 'string' &&
        /\b(?:stream )?timeout\b/i.test(message)) ||
      (typeof message === 'string' &&
        /^(?:fetch failed|failed to fetch)$/i.test(message.trim())) ||
      getErrorClassNames(link).some((name) =>
        /(?:Connection|Timeout)Error$/.test(name),
      )
    );
  });
}

/**
 * Reads a failed attempt on `bound`. The bound route is the credential route
 * the attempt ran under: SuperGrok and Kimi Code share their API-key host, so
 * it is the only signal that separates a subscription quota failure from a key
 * rate limit, and the subscription detectors read it back off the error.
 * `partialText` is the tail of the text the attempt had already streamed: the
 * one producer of the field the retry surface shows, now that the loop rather
 * than a provider handler is what watches the stream.
 */
export function classifyModelFailure(
  cause: unknown,
  bound: Pick<BoundModel, 'usageRoute' | 'config'>,
  partialText?: string,
): ModelFailure {
  const packageError = cause instanceof ModelError ? cause : null;
  const sdkError =
    packageError?.cause instanceof Error ? packageError.cause : null;
  const error = sdkError ?? ensureError(cause);
  if (packageError !== null && isPackageContextOverflow(packageError)) {
    attachContextWindowError(error);
  }
  attachSdkUsageRoute(error, bound.usageRoute);
  const formatted = normalizeProviderError(error);
  // A sub-400 package status (an SSE 200 carrying an error body) never
  // outranks the status the body resolves to.
  const packageStatus = packageError?.status;
  const statusCode =
    packageStatus !== undefined && packageStatus >= 400
      ? packageStatus
      : (formatted.statusCode ?? packageStatus);
  const withPackageFacts: ProviderError = {
    ...formatted,
    provider: bound.config.provider,
    message:
      formatted.message.trim() !== ''
        ? formatted.message
        : (packageError?.message ?? error.message),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(packageError?.requestId !== undefined
      ? { requestId: packageError.requestId }
      : {}),
    // A provider reply the SDK surfaced with no status, and none in its body,
    // is not one to repeat blindly; a status-less transport failure is.
    ...(packageError?.kind === 'provider-rejection' &&
    sdkError !== null &&
    statusCode === undefined &&
    getExhaustionReason(formatted) === undefined
      ? { userRetryable: false }
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
  const modelScoped =
    getExhaustionReason(withPackageFacts) === undefined &&
    isModelScopedRateLimitBody(withPackageFacts.rawErrorBody);
  let rateLimitScope: ModelRouteVerdict['rateLimitScope'];
  if (statusCode === StatusCodes.TOO_MANY_REQUESTS) {
    rateLimitScope = modelScoped ? 'model' : 'wire';
  }
  return {
    error,
    formatted: withPackageFacts,
    info: toRetryErrorInfo(withPackageFacts),
    autoRetryable,
    storedResponseGone:
      withPackageFacts.statusCode === 404 ||
      ((withPackageFacts.statusCode === 400 ||
        withPackageFacts.statusCode === undefined) &&
        /previous[_ ]?(response|interaction)/i.test(withPackageFacts.message) &&
        /not found|expired|no longer|does not exist/i.test(
          withPackageFacts.message,
        )),
    verdict: {
      rateLimitScope,
      exhaustionReason: getExhaustionReason(withPackageFacts),
      wireRouteFailure:
        rateLimitScope === 'wire' ||
        (packageError?.kind === 'transport' &&
          hasNetworkEvidence(packageError)) ||
        statusCode === StatusCodes.REQUEST_TIMEOUT ||
        (statusCode !== undefined && statusCode >= 500),
      retryAfterMs: packageError?.retryAfterMs,
    },
  };
}
