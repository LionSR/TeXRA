import { StatusCodes } from 'http-status-codes';
import { ExhaustionReasonSchema, type ExhaustionReason } from '@shared/schemas';
import { isFiniteNumber, isObject, isString } from '@utils/core';

export type SdkErrorKind =
  | 'connection_timeout'
  | 'connection'
  | 'user_abort'
  | 'bad_request'
  | 'authentication'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'unprocessable_entity'
  | 'rate_limit'
  | 'internal_server'
  | 'api_error';

export interface SdkErrorMetadata {
  provider: string;
  kind: SdkErrorKind;
  statusCode?: number;
  exhaustionReason?: ExhaustionReason;
}

export function isSdkErrorMetadata(value: unknown): value is SdkErrorMetadata {
  if (!isObject(value)) return false;
  const candidate = value as {
    provider?: unknown;
    kind?: unknown;
    statusCode?: unknown;
    exhaustionReason?: unknown;
  };
  return (
    isString(candidate.provider) &&
    SDK_ERRORS_BY_KIND.has(candidate.kind as SdkErrorKind) &&
    (candidate.statusCode === undefined ||
      isFiniteNumber(candidate.statusCode)) &&
    (candidate.exhaustionReason === undefined ||
      ExhaustionReasonSchema.safeParse(candidate.exhaustionReason).success)
  );
}

/** SDK error mapping entry. */
export interface SdkErrorEntry {
  kind: SdkErrorKind;
  classNames: readonly string[];
  message?: string;
  fallbackStatusCode?: number;
  userRetryable?: boolean;
}

export const SDK_ERRORS: readonly SdkErrorEntry[] = [
  // Connection errors (transient — show retry button)
  {
    kind: 'connection_timeout',
    classNames: ['APIConnectionTimeoutError'],
    message: 'Connection timed out',
    userRetryable: true,
  },
  {
    kind: 'connection',
    classNames: ['APIConnectionError'],
    message: 'Connection error',
    userRetryable: true,
  },
  // Abort errors (user cancelled — no retry button)
  {
    kind: 'user_abort',
    classNames: ['APIUserAbortError'],
    message: 'Request aborted',
    userRetryable: false,
  },
  // HTTP errors (retryable derived from status code)
  {
    kind: 'bad_request',
    classNames: ['BadRequestError'],
    fallbackStatusCode: StatusCodes.BAD_REQUEST,
  },
  {
    kind: 'authentication',
    classNames: ['AuthenticationError'],
    fallbackStatusCode: StatusCodes.UNAUTHORIZED,
  },
  {
    kind: 'permission_denied',
    classNames: ['PermissionDeniedError'],
    fallbackStatusCode: StatusCodes.FORBIDDEN,
  },
  {
    kind: 'not_found',
    classNames: ['NotFoundError'],
    fallbackStatusCode: StatusCodes.NOT_FOUND,
  },
  {
    kind: 'conflict',
    classNames: ['ConflictError'],
    fallbackStatusCode: StatusCodes.CONFLICT,
  },
  {
    kind: 'unprocessable_entity',
    classNames: ['UnprocessableEntityError'],
    fallbackStatusCode: StatusCodes.UNPROCESSABLE_ENTITY,
  },
  {
    kind: 'rate_limit',
    classNames: ['RateLimitError'],
    fallbackStatusCode: StatusCodes.TOO_MANY_REQUESTS,
  },
  {
    kind: 'internal_server',
    classNames: ['InternalServerError'],
    fallbackStatusCode: StatusCodes.INTERNAL_SERVER_ERROR,
  },
  // Generic API errors (no fallback)
  { kind: 'api_error', classNames: ['APIError', 'ApiError'] },
];

export const SDK_ERRORS_BY_KIND = new Map(
  SDK_ERRORS.map((entry) => [entry.kind, entry] as const),
);

const SDK_ERROR_KIND_BY_FALLBACK_STATUS = new Map(
  SDK_ERRORS.flatMap((entry) =>
    entry.fallbackStatusCode === undefined
      ? []
      : [[entry.fallbackStatusCode, entry.kind] as const],
  ),
);

/** Maps known provider HTTP status codes to the shared SDK error kind table. */
export function sdkErrorKindFromStatusCode(
  statusCode: number | undefined,
): SdkErrorKind {
  if (statusCode === undefined) return 'api_error';
  return SDK_ERROR_KIND_BY_FALLBACK_STATUS.get(statusCode) ?? 'api_error';
}

/** Server errors (5xx), conflicts (409), rate limits (429), and request timeouts
 *  (408) are retryable — these are transient. Other client errors (4xx) are
 *  deterministic. */
export function isRetryableStatusCode(statusCode?: number): boolean {
  if (statusCode === undefined) return false;
  if (statusCode >= 500) return true;
  return (
    statusCode === StatusCodes.CONFLICT ||
    statusCode === StatusCodes.TOO_MANY_REQUESTS ||
    statusCode === StatusCodes.REQUEST_TIMEOUT
  );
}

export function pickStatus(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}
