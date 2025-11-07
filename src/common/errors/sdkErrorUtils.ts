// Third-party imports
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
  BadRequestError as AnthropicBadRequestError,
  ConflictError as AnthropicConflictError,
  InternalServerError as AnthropicInternalServerError,
  NotFoundError as AnthropicNotFoundError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
  UnprocessableEntityError as AnthropicUnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleGenAIApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  ConflictError as OpenAIConflictError,
  InternalServerError as OpenAIInternalServerError,
  NotFoundError as OpenAINotFoundError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
  UnprocessableEntityError as OpenAIUnprocessableEntityError,
} from 'openai';

export interface ProviderHttpErrorDetails {
  message: string;
  statusCode?: number;
  statusText?: string;
  provider?: string;
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid parameters.',
  401: 'Invalid API key.',
  402: 'Insufficient credits.',
  403: 'Permission denied.',
  404: 'Resource not found.',
  409: 'Conflict error.',
  422: 'Unprocessable entity.',
  429: 'Rate limit exceeded.',
  500: 'Provider error.',
  502: 'Provider error.',
  503: 'No available providers.',
  504: 'Provider timeout.',
};

type ErrorConstructor<T extends Error = Error> = new (...args: any[]) => T;

interface NativeMessageErrorEntry {
  ctor: ErrorConstructor;
  provider: string;
  message?: string;
}

interface NativeHttpErrorEntry {
  ctor: ErrorConstructor;
  provider: string;
  fallbackStatusCode?: number;
}

const NATIVE_MESSAGE_ERRORS: NativeMessageErrorEntry[] = [
  {
    ctor: OpenAIConnectionTimeoutError,
    provider: 'openai',
    message: 'Connection timed out.',
  },
  {
    ctor: AnthropicConnectionTimeoutError,
    provider: 'anthropic',
    message: 'Connection timed out.',
  },
  {
    ctor: OpenAIConnectionError,
    provider: 'openai',
    message: 'Connection error.',
  },
  {
    ctor: AnthropicConnectionError,
    provider: 'anthropic',
    message: 'Connection error.',
  },
  {
    ctor: OpenAIUserAbortError,
    provider: 'openai',
    message: 'Request aborted.',
  },
  {
    ctor: AnthropicUserAbortError,
    provider: 'anthropic',
    message: 'Request aborted.',
  },
];

const NATIVE_HTTP_ERRORS: NativeHttpErrorEntry[] = [
  { ctor: OpenAIBadRequestError, provider: 'openai', fallbackStatusCode: 400 },
  {
    ctor: AnthropicBadRequestError,
    provider: 'anthropic',
    fallbackStatusCode: 400,
  },
  {
    ctor: OpenAIAuthenticationError,
    provider: 'openai',
    fallbackStatusCode: 401,
  },
  {
    ctor: AnthropicAuthenticationError,
    provider: 'anthropic',
    fallbackStatusCode: 401,
  },
  {
    ctor: OpenAIPermissionDeniedError,
    provider: 'openai',
    fallbackStatusCode: 403,
  },
  {
    ctor: AnthropicPermissionDeniedError,
    provider: 'anthropic',
    fallbackStatusCode: 403,
  },
  { ctor: OpenAINotFoundError, provider: 'openai', fallbackStatusCode: 404 },
  {
    ctor: AnthropicNotFoundError,
    provider: 'anthropic',
    fallbackStatusCode: 404,
  },
  { ctor: OpenAIConflictError, provider: 'openai', fallbackStatusCode: 409 },
  {
    ctor: AnthropicConflictError,
    provider: 'anthropic',
    fallbackStatusCode: 409,
  },
  {
    ctor: OpenAIUnprocessableEntityError,
    provider: 'openai',
    fallbackStatusCode: 422,
  },
  {
    ctor: AnthropicUnprocessableEntityError,
    provider: 'anthropic',
    fallbackStatusCode: 422,
  },
  { ctor: OpenAIRateLimitError, provider: 'openai', fallbackStatusCode: 429 },
  {
    ctor: AnthropicRateLimitError,
    provider: 'anthropic',
    fallbackStatusCode: 429,
  },
  {
    ctor: OpenAIInternalServerError,
    provider: 'openai',
    fallbackStatusCode: 500,
  },
  {
    ctor: AnthropicInternalServerError,
    provider: 'anthropic',
    fallbackStatusCode: 500,
  },
  { ctor: OpenAIAPIError, provider: 'openai' },
  { ctor: AnthropicAPIError, provider: 'anthropic' },
  { ctor: GoogleGenAIApiError, provider: 'google' },
];

function matchNativeMessageError(
  err: unknown,
): ProviderHttpErrorDetails | undefined {
  for (const entry of NATIVE_MESSAGE_ERRORS) {
    if (err instanceof entry.ctor) {
      const message =
        entry.message ??
        extractMessage(err) ??
        'An unexpected provider error occurred.';
      return {
        message,
        provider: entry.provider,
      };
    }
  }

  return undefined;
}

function matchNativeHttpError(
  err: unknown,
): ProviderHttpErrorDetails | undefined {
  for (const entry of NATIVE_HTTP_ERRORS) {
    if (!(err instanceof entry.ctor)) {
      continue;
    }

    const statusCode = detectStatusCode(err) ?? entry.fallbackStatusCode;
    const statusText = detectStatusText(err, statusCode);
    const rawMessage = extractMessage(err);
    const fallbackMessage = statusCode
      ? STATUS_DESCRIPTIONS[statusCode]
      : undefined;
    const finalMessage =
      rawMessage ?? fallbackMessage ?? 'An unexpected provider error occurred.';

    if (statusCode) {
      const prefix = `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`;
      return {
        message: `${prefix} – ${finalMessage}`,
        statusCode,
        statusText,
        provider: entry.provider,
      };
    }

    return {
      message: finalMessage,
      provider: entry.provider,
    };
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function detectStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }

  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    error?: { status?: unknown };
  };

  return (
    toNumber(candidate.status) ??
    toNumber(candidate.statusCode) ??
    toNumber(candidate.code) ??
    toNumber(candidate.response?.status) ??
    toNumber(candidate.error?.status)
  );
}

function detectStatusText(
  err: unknown,
  statusCode?: number,
): string | undefined {
  if (!err || typeof err !== 'object') {
    return statusCode ? STATUS_TITLES[statusCode] : undefined;
  }

  const candidate = err as {
    statusText?: unknown;
    response?: { statusText?: unknown };
    error?: { statusText?: unknown };
  };

  const rawText =
    candidate.statusText ??
    candidate.response?.statusText ??
    candidate.error?.statusText ??
    (statusCode ? STATUS_TITLES[statusCode] : undefined);

  return typeof rawText === 'string' ? rawText : undefined;
}

function detectProvider(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }

  const candidate = err as { provider?: unknown; name?: unknown } & {
    constructor?: { name?: unknown };
  };

  if (typeof candidate.provider === 'string') {
    return candidate.provider;
  }

  const names = [candidate.name, candidate.constructor?.name];

  for (const name of names) {
    if (typeof name !== 'string') {
      continue;
    }

    const lowered = name.toLowerCase();
    if (lowered.includes('openai')) {
      return 'openai';
    }
    if (lowered.includes('anthropic')) {
      return 'anthropic';
    }
    if (lowered.includes('google')) {
      return 'google';
    }
    if (lowered.includes('kimi')) {
      return 'kimi';
    }
  }

  return undefined;
}

function extractMessage(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.message === 'string') {
    const trimmed = err.message.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof err === 'string') {
    const trimmed = err.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

export function formatProviderHttpError(
  err: unknown,
): ProviderHttpErrorDetails {
  const nativeMessage = matchNativeMessageError(err);
  if (nativeMessage) {
    return nativeMessage;
  }

  const nativeHttp = matchNativeHttpError(err);
  if (nativeHttp) {
    return nativeHttp;
  }

  const statusCode = detectStatusCode(err);
  const statusText = detectStatusText(err, statusCode);
  const provider = detectProvider(err);

  const rawMessage = extractMessage(err);
  const fallbackMessage = statusCode
    ? STATUS_DESCRIPTIONS[statusCode]
    : undefined;
  const finalMessage =
    rawMessage ?? fallbackMessage ?? 'An unexpected provider error occurred.';

  if (statusCode) {
    const prefix = `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`;
    return {
      message: `${prefix} – ${finalMessage}`,
      statusCode,
      statusText,
      provider,
    };
  }

  return {
    message: finalMessage,
    provider,
  };
}

export function getSdkErrorMessage(err: unknown): string {
  return formatProviderHttpError(err).message;
}
