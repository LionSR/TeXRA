import { StatusCodes } from 'http-status-codes';
import { isFiniteNumber } from '@utils/core';

type SdkErrorKind =
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
