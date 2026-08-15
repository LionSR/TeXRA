// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIUserAbortError as AnthropicAPIUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  NotFoundError as OpenAINotFoundError,
  RateLimitError as OpenAIRateLimitError,
} from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  tagAnthropicSdkError,
  tagGoogleSdkError,
  tagOpenAISdkError,
} from '@agent/modelHandlers/support/sdkErrorMetadata';
import {
  attachContextWindowError,
  attachProviderError,
  attachSdkErrorMetadata,
  attachStreamDiagnostics,
} from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isPreviousResponseIdError,
  isUserAbort,
} from '@common/errors/sdkError/errorPatterns';
import {
  buildErrorLogData,
  formatProviderHttpError,
  getSdkErrorMessage,
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import { sdkErrorKindFromStatusCode } from '@common/errors/sdkError/sdkErrorKinds';
import type { ProviderError, RetryErrorInfo } from '@shared/schemas/errors';
import {
  ErrorLogDataSchema,
  RetryErrorInfoSchema,
  toRetryErrorInfo,
} from '@shared/schemas/errors';

class APIError extends Error {}

class BadRequestError extends APIError {}

class KimiAPIError extends APIError {}

class APIUserAbortError extends APIError {}

class UnknownSdkApiError extends APIError {}

function withHeaders<T extends Error>(
  error: T,
  headers: Record<string, string>,
): T & { headers: Headers } {
  return Object.assign(error, { headers: new Headers(headers) });
}

function taggedRawBodyError(
  message: string,
  body: unknown,
  metadata: Parameters<typeof attachSdkErrorMetadata>[1],
): Error {
  const error = new Error(message) as Error & { error: unknown };
  error.error = body;
  attachSdkErrorMetadata(error, metadata);
  return error;
}

function providerAttributedError(body: unknown): Error {
  const error = new Error('background response failed') as Error & {
    error: unknown;
    provider: string;
  };
  error.error = body;
  error.provider = 'openai';
  return error;
}

describe('formatProviderHttpError', () => {
  it('matches generic SDK API errors through the prototype chain', () => {
    const formatted = formatProviderHttpError(
      new UnknownSdkApiError('new provider error shape'),
    );

    expect(formatted.message).toBe('new provider error shape');
    expect(formatted.userRetryable).toBe(false);
  });

  it('detects OpenAI provider errors without importing SDK classes at runtime', () => {
    const formatted = formatProviderHttpError(
      new OpenAIRateLimitError(429, {}, 'rate limited', new Headers()),
    );

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.userRetryable).toBe(true);
  });

  it('detects Anthropic provider errors without importing SDK classes at runtime', () => {
    const formatted = formatProviderHttpError(
      new AnthropicAuthenticationError(401, {}, 'bad key', new Headers()),
    );

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.statusCode).toBe(401);
    expect(formatted.userRetryable).toBe(false);
  });

  it('matches SDK abort errors through the prototype chain', () => {
    expect(isUserAbort(new APIUserAbortError('aborted'))).toBe(true);
  });

  it('preserves native SDK abort detection for packaged builds', () => {
    expect(isUserAbort(new OpenAIAPIUserAbortError())).toBe(true);
    expect(isUserAbort(new AnthropicAPIUserAbortError())).toBe(true);
  });

  it('detects AbortController DOMException aborts', () => {
    expect(isUserAbort(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('preserves provider context for native OpenAI HTTP errors', () => {
    const formatted = formatProviderHttpError(
      new OpenAIAuthenticationError(
        401,
        { message: 'invalid api key', type: 'invalid_request_error' },
        'invalid api key',
        new Headers({ 'x-request-id': 'req-openai' }),
      ),
    );

    expect(formatted.provider).toBe('openai');
    expect(formatted.requestId).toBe('req-openai');
    expect(formatted.statusCode).toBe(401);
  });

  it.each([
    {
      provider: 'openai',
      connection: () =>
        new OpenAIAPIConnectionError({
          message: 'network unavailable',
          cause: new Error('socket closed'),
        }),
      timeout: () =>
        new OpenAIAPIConnectionTimeoutError({ message: 'timed out' }),
    },
    {
      provider: 'anthropic',
      connection: () =>
        new AnthropicAPIConnectionError({
          message: 'network unavailable',
          cause: new Error('socket closed'),
        }),
      timeout: () =>
        new AnthropicAPIConnectionTimeoutError({ message: 'timed out' }),
    },
  ])(
    'preserves provider context for native $provider connection errors without response headers',
    ({ provider, connection, timeout }) => {
      const connectionError = formatProviderHttpError(connection());
      const timeoutError = formatProviderHttpError(timeout());

      expect(connectionError.provider).toBe(provider);
      expect(connectionError.userRetryable).toBe(true);
      expect(timeoutError.provider).toBe(provider);
      expect(timeoutError.userRetryable).toBe(true);
    },
  );

  it('preserves provider context for native Anthropic HTTP errors', () => {
    const formatted = formatProviderHttpError(
      new AnthropicAuthenticationError(
        401,
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid api key' },
        },
        'invalid api key',
        new Headers({ 'request-id': 'req-anthropic' }),
      ),
    );

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.requestId).toBe('req-anthropic');
    expect(formatted.statusCode).toBe(401);
  });

  it('prefers Anthropic request-id when response headers include both request id styles', () => {
    const err = withHeaders(new UnknownSdkApiError('upstream auth failed'), {
      'request-id': 'req-anthropic',
      'x-request-id': 'req-openai-compatible',
    });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.requestId).toBe('req-anthropic');
  });

  it('prefers relay correlation ids over provider request ids', () => {
    const err = withHeaders(new UnknownSdkApiError('relay timed out'), {
      'request-id': 'req-anthropic',
      'x-relay-request-id': 'relay-123',
    });
    Object.assign(err, { request_id: 'req-anthropic' });

    const formatted = formatProviderHttpError(err);

    expect(formatted.requestId).toBe('relay-123');
  });

  it('does not infer OpenAI from generic x-request-id headers', () => {
    const err = withHeaders(
      new UnknownSdkApiError('openai-compatible gateway failed'),
      { 'x-request-id': 'req-compatible' },
    );

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBeUndefined();
    expect(formatted.requestId).toBe('req-compatible');
  });

  it('prefers SDK class provider hints over OpenAI-compatible request headers', () => {
    const err = withHeaders(new KimiAPIError('moonshot auth failed'), {
      'x-request-id': 'req-kimi',
    });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('moonshot');
    expect(formatted.requestId).toBe('req-kimi');
  });

  it.each([
    {
      provider: 'openai',
      makeError: () => new BadRequestError('invalid request'),
      stack: String.raw`BadRequestError: invalid request
    at request (C:\repo\node_modules\.pnpm\openai@5.0.0\node_modules\openai\core\error.mjs:12:10)`,
      statusCode: 400,
    },
    {
      provider: 'anthropic',
      makeError: () => new APIError('provider failed'),
      stack: String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@anthropic-ai+sdk@1.0.0\node_modules\@anthropic-ai\sdk\index.mjs:12:10)`,
      statusCode: undefined,
    },
    {
      provider: 'google',
      makeError: () => new APIError('provider failed'),
      stack: String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@google+genai@1.0.0\node_modules\@google\genai\dist\index.mjs:12:10)`,
      statusCode: undefined,
    },
  ])(
    'detects $provider provider from Windows pnpm stack paths',
    ({ provider, makeError, stack, statusCode }) => {
      const err = makeError();
      err.stack = stack;

      const formatted = formatProviderHttpError(err);

      expect(formatted.provider).toBe(provider);
      if (statusCode !== undefined) {
        expect(formatted.statusCode).toBe(statusCode);
      }
      expect(formatted.userRetryable).toBe(false);
    },
  );

  it('keeps SDK user aborts non-retryable while preserving provider attribution', () => {
    const err = new APIUserAbortError('aborted by user');
    err.stack = String.raw`APIUserAbortError: aborted by user
    at request (C:\repo\node_modules\.pnpm\openai@5.0.0\node_modules\openai\core\error.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.message).toBe('Request aborted');
    expect(formatted.provider).toBe('openai');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats symbol-tagged SDK errors without SDK prototype matching', () => {
    const error = new Error('provider quota');
    attachSdkErrorMetadata(error, {
      provider: 'fixture',
      kind: 'rate_limit',
      statusCode: 429,
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('fixture');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.message).toBe(
      'HTTP 429 Too Many Requests – provider quota',
    );
    expect(formatted.userRetryable).toBe(true);
  });

  it('carries an SDK exhaustion reason into the provider error', () => {
    const error = new Error('Copilot quota exceeded');
    attachSdkErrorMetadata(error, {
      provider: 'copilot',
      kind: 'rate_limit',
      exhaustionReason: 'copilot-subscription',
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted).toMatchObject({
      provider: 'copilot',
      statusCode: 429,
      exhaustionReason: 'copilot-subscription',
      userRetryable: true,
    });
  });

  it('classifies relay monthly-limit messages as credential exhaustion', () => {
    const error = new Error(
      '429 Monthly spending limit reached ($300). Current usage: $623.16.',
    );
    attachSdkErrorMetadata(error, {
      provider: 'fixture',
      kind: 'rate_limit',
      statusCode: 429,
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.statusCode).toBe(429);
    expect(formatted.isRelayError).toBe(true);
    expect(formatted.exhaustionReason).toBe('relay-limit');
    expect(formatted.userRetryable).toBe(true);
  });

  it('formats tagged OpenAI connection errors with existing retry behavior', () => {
    const error = new OpenAIAPIConnectionTimeoutError();
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.message).toBe('Connection timed out');
    expect(formatted.userRetryable).toBe(true);
  });

  it('infers a retryable 500 from a status-less OpenAI server_error body', () => {
    const body = {
      type: 'server_error',
      code: 'server_error',
      message:
        'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 988f71d8-3453-46f1-a466-529d2a967244 in your message.',
      param: null,
    };
    const error = new OpenAIAPIError(undefined, body, body.message, undefined);
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(500);
    expect(formatted.userRetryable).toBe(true);
    expect(formatted.rawErrorBody).toEqual(body);
  });

  it('infers a retryable 503 from a status-less OpenAI overload body', () => {
    const body = {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
      param: null,
    };
    const error = new OpenAIAPIError(undefined, body, body.message, undefined);
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(503);
    expect(formatted.userRetryable).toBe(true);
    expect(isProviderErrorAutoRetryable(error)).toBe(true);
    expect(formatted.rawErrorBody).toEqual(body);

    const codeOnlyBody = {
      code: 'server_is_overloaded',
      message: body.message,
    };
    const codeOnlyError = new OpenAIAPIError(
      undefined,
      codeOnlyBody,
      codeOnlyBody.message,
      undefined,
    );
    tagOpenAISdkError(codeOnlyError, 'openai');

    expect(formatProviderHttpError(codeOnlyError).statusCode).toBe(503);
  });

  it('keeps unknown status-less OpenAI API errors non-retryable', () => {
    const body = {
      type: 'unexpected_error',
      code: 'unexpected_error',
      message: 'Unexpected provider failure.',
    };
    const error = new OpenAIAPIError(undefined, body, body.message, undefined);
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats tagged OpenAI HTTP errors with status metadata', () => {
    const error = new OpenAIBadRequestError(
      400,
      { message: 'bad payload' },
      'bad payload',
      new Headers([['x-request-id', 'req_123']]),
    );
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(400);
    expect(formatted.statusText).toBe('Bad Request');
    expect(formatted.message).toContain('HTTP 400 Bad Request');
    expect(formatted.message).toContain('bad payload');
    expect(formatted.requestId).toBe('req_123');
    expect(formatted.userRetryable).toBe(false);
  });

  it('does not promote a serialized provider response body into the message', () => {
    const privatePrompt = 'private request body content';
    const body = {
      request: { prompt: privatePrompt },
      authorization: 'opaque credential',
    };
    const error = new OpenAIBadRequestError(
      400,
      body,
      `400 ${JSON.stringify(body)}`,
      new Headers(),
    );
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe('HTTP 400 Bad Request – Bad Request');
    expect(formatted.message).not.toContain(privatePrompt);
    expect(formatted.message).not.toContain('opaque credential');
    expect(formatted.rawErrorBody).toEqual(body);
  });

  it('does not promote a pretty-printed provider response body into the message', () => {
    const privatePrompt = 'private pretty-printed request content';
    const body = {
      request: { prompt: privatePrompt },
      authorization: 'opaque pretty-printed credential',
    };
    const reorderedBody = {
      authorization: body.authorization,
      request: body.request,
    };
    const error = taggedRawBodyError(
      `400 ${JSON.stringify(reorderedBody, null, 2)}`,
      body,
      {
        provider: 'openai',
        kind: 'bad_request',
        statusCode: 400,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe('HTTP 400 Bad Request – Bad Request');
    expect(formatted.message).not.toContain(privatePrompt);
    expect(formatted.message).not.toContain('opaque pretty-printed credential');
    expect(formatted.rawErrorBody).toEqual(body);
  });

  it('retains a useful wrapper explanation when the raw body is plain text', () => {
    const error = taggedRawBodyError(
      'The provider rejected this request because the model is unavailable.',
      'upstream plain-text response',
      {
        provider: 'openai',
        kind: 'bad_request',
        statusCode: 400,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe(
      'HTTP 400 Bad Request – The provider rejected this request because the model is unavailable.',
    );
    expect(formatted.rawErrorBody).toBe('upstream plain-text response');
  });

  it('does not promote a serialized plain-text response body into the message', () => {
    const privateBody = 'private prompt and opaque authorization';
    const error = new OpenAIBadRequestError(
      400,
      privateBody,
      'ignored by the OpenAI error constructor',
      new Headers(),
    );
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe('HTTP 400 Bad Request – Bad Request');
    expect(formatted.message).not.toContain(privateBody);
    expect(formatted.rawErrorBody).toBe(privateBody);
  });

  it('formats cyclic diagnostic bodies without throwing', () => {
    const body: { kind: string; self?: unknown } = { kind: 'provider-error' };
    body.self = body;
    const error = taggedRawBodyError(
      'The provider failed while reporting {"kind":"provider-error"}.',
      body,
      {
        provider: 'openai',
        kind: 'bad_request',
        statusCode: 400,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe(
      'HTTP 400 Bad Request – The provider failed while reporting {"kind":"provider-error"}.',
    );
    expect(formatted.rawErrorBody).toBe(body);
  });

  it('retains a wrapper explanation that does not serialize its response body', () => {
    const body = { code: 'unsupported_response_format' };
    const error = taggedRawBodyError(
      'The selected model does not support this response format.',
      body,
      {
        provider: 'openai',
        kind: 'bad_request',
        statusCode: 400,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe(
      'HTTP 400 Bad Request – The selected model does not support this response format.',
    );
    expect(formatted.rawErrorBody).toEqual(body);
  });

  it('classifies OpenAI insufficient_quota bodies as credential exhaustion', () => {
    const error = taggedRawBodyError(
      'quota exhausted',
      {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
      {
        provider: 'openai',
        kind: 'rate_limit',
        statusCode: 429,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.exhaustionReason).toBe('upstream-credit');
    expect(formatted.userRetryable).toBe(true);
  });

  it('classifies OpenAI quota messages without code as credential exhaustion', () => {
    const error = taggedRawBodyError(
      'quota exhausted',
      {
        message:
          'You exceeded your current quota, please check your plan and billing details.',
      },
      {
        provider: 'openai',
        kind: 'rate_limit',
        statusCode: 429,
      },
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.exhaustionReason).toBe('upstream-credit');
    expect(formatted.userRetryable).toBe(true);
  });

  it('classifies provider-attributed OpenAI quota bodies without SDK metadata', () => {
    const error = providerAttributedError({
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.exhaustionReason).toBe('upstream-credit');
    expect(formatted.userRetryable).toBe(true);
  });

  it('infers a retryable status for provider-attributed background server errors', () => {
    const error = providerAttributedError({
      message: 'The background response ended before completion.',
      type: 'server_error',
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(500);
    expect(formatted.exhaustionReason).toBeUndefined();
    expect(formatted.userRetryable).toBe(true);
  });

  it('treats provider empty responses as retryable transient failures', () => {
    const formatted = formatProviderHttpError(
      new Error('No output generated - API returned empty response'),
    );

    expect(formatted.message).toBe(
      'No output generated - API returned empty response',
    );
    expect(formatted.userRetryable).toBe(true);
  });

  it('formats tagged Anthropic user abort errors', () => {
    const error = new AnthropicAPIUserAbortError();
    tagAnthropicSdkError(error, 'anthropic');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.message).toBe('Request aborted');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats tagged Anthropic HTTP errors with status-derived metadata', () => {
    const error = new AnthropicAuthenticationError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid key' },
      },
      'invalid key',
      new Headers([['request-id', 'req_anthropic']]),
    );
    tagAnthropicSdkError(error, 'anthropic');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.statusCode).toBe(401);
    expect(formatted.statusText).toBe('Unauthorized');
    expect(formatted.message).toContain('HTTP 401 Unauthorized');
    expect(formatted.message).toContain('invalid key');
    expect(formatted.requestId).toBe('req_anthropic');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats tagged Google API errors with inferred kind from status', () => {
    const error = new GoogleApiError({
      message: 'quota exceeded',
      status: 429,
    });
    tagGoogleSdkError(error, 'google');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('google');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.message).toBe(
      'HTTP 429 Too Many Requests – quota exceeded',
    );
    expect(formatted.userRetryable).toBe(true);
  });

  it('derives SDK error kinds from the shared status mapping', () => {
    expect(sdkErrorKindFromStatusCode(400)).toBe('bad_request');
    expect(sdkErrorKindFromStatusCode(401)).toBe('authentication');
    expect(sdkErrorKindFromStatusCode(403)).toBe('permission_denied');
    expect(sdkErrorKindFromStatusCode(404)).toBe('not_found');
    expect(sdkErrorKindFromStatusCode(409)).toBe('conflict');
    expect(sdkErrorKindFromStatusCode(422)).toBe('unprocessable_entity');
    expect(sdkErrorKindFromStatusCode(429)).toBe('rate_limit');
    expect(sdkErrorKindFromStatusCode(500)).toBe('internal_server');
    expect(sdkErrorKindFromStatusCode(418)).toBe('api_error');
    expect(sdkErrorKindFromStatusCode(undefined)).toBe('api_error');
  });

  it('does not cache a fresh normalization, so metadata attached afterward is still surfaced', () => {
    const error = new Error('stream failed');
    attachSdkErrorMetadata(error, {
      provider: 'fixture',
      kind: 'api_error',
      statusCode: 500,
    });

    // Mirrors the Anthropic stream path: an early debug-log call formats the
    // error before stream diagnostics are attached to it.
    const before = normalizeProviderError(error);
    expect(before.provider).toBe('fixture');
    expect(before.statusCode).toBe(500);
    expect(before.streamDiagnostics).toBeUndefined();

    const diagnostics = {
      thinkingChars: 0,
      textChars: 12,
      toolInputChars: 0,
      blockTypesSeen: ['text'],
      eventsProcessed: 7,
      lastEventType: 'content_block_delta',
      elapsedSecs: 1.2,
      secsSinceLastEvent: 0.3,
      finalized: false,
      messageStartReceived: true,
      messageStopReceived: false,
      stopReason: null,
      anthropicMessageId: null,
    };
    attachStreamDiagnostics(error, diagnostics);

    // A fresh normalize must reflect the newly-attached diagnostics — i.e. the
    // earlier call must NOT have cached a diagnostics-less ProviderError on the
    // error (which would otherwise be returned here and lose the diagnostics).
    const after = normalizeProviderError(error);
    expect(after.streamDiagnostics).toEqual(diagnostics);
    expect(after.statusCode).toBe(500);
  });
});

describe('isContextWindowError', () => {
  it('recognizes a TeXRA-internal throw via its typed marker, independent of wording', () => {
    // ModelHandler.validateTokenLimits tags its own throw with
    // attachContextWindowError() instead of relying on isContextWindowError
    // string-matching the exact message it owns.
    const err = new Error(
      'Token count of message exceeds context window: 5 > 3',
    );
    attachContextWindowError(err);

    expect(isContextWindowError(err)).toBe(true);
  });

  it('still recognizes the marker after the internal message wording changes', () => {
    // The marker decouples classification from message text: even if
    // ModelHandler reworks its wording entirely, the marker still matches.
    const err = new Error('Input is too large for this model to process.');
    attachContextWindowError(err);

    expect(isContextWindowError(err)).toBe(true);
  });

  it('still matches third-party provider wording without a marker (fenced patterns)', () => {
    expect(isContextWindowError(new Error('context length exceeded'))).toBe(
      true,
    );
    expect(
      isContextWindowError(new Error('Maximum context length is 128000.')),
    ).toBe(true);
  });

  it('recognizes the marker through a cause chain (rethrown/wrapped error)', () => {
    // Errors are frequently rewrapped as they propagate (e.g. `new Error(msg,
    // { cause })`). The marker must still be found via `findInCauseChain`,
    // not just on the outermost error.
    const inner = new Error(
      'Token count of message exceeds context window: 5 > 3',
    );
    attachContextWindowError(inner);
    const outer = new Error('request failed', { cause: inner });

    expect(isContextWindowError(outer)).toBe(true);
  });

  it('does not misclassify an unrelated error as a context-window violation', () => {
    expect(isContextWindowError(new Error('rate limit exceeded'))).toBe(false);
  });

  it("recognizes OpenAI's native error code even when the message wording is unfamiliar", () => {
    // The SDK flattens error.code from the JSON body onto the thrown
    // APIError/BadRequestError instance. A future model generation could
    // reword the message freely without breaking detection, because this
    // never inspects `.message`.
    const err = new OpenAIBadRequestError(
      400,
      { code: 'context_length_exceeded', message: 'Some brand-new wording' },
      'Some brand-new wording',
      new Headers(),
    );

    expect(isContextWindowError(err)).toBe(true);
  });

  it('recognizes a nested error.code (e.g. a WebSocket error wrapper) without a top-level code', () => {
    // Mirrors OpenAIResponseWebSocketTransport's onFailed wrapper, which
    // preserves the response's structured `error` object on the thrown
    // Error instead of just its `.message`.
    const err = new Error(
      'OpenAI WebSocket response failed: overflow',
    ) as Error & {
      error?: unknown;
    };
    err.error = { code: 'context_length_exceeded', message: 'overflow' };

    expect(isContextWindowError(err)).toBe(true);
  });

  it('does not match an unrelated native error code', () => {
    const err = new OpenAIRateLimitError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many requests' },
      'Too many requests',
      new Headers(),
    );

    expect(isContextWindowError(err)).toBe(false);
  });
});

describe('isPreviousResponseIdError', () => {
  it("recognizes OpenAI's native param field naming previous_response_id", () => {
    // The SDK flattens error.param from the JSON body onto the thrown
    // APIError/BadRequestError instance — this identifies the invalid
    // parameter directly, independent of how OpenAI phrases the message.
    const err = new OpenAIBadRequestError(
      400,
      { param: 'previous_response_id', message: 'Some brand-new wording' },
      'Some brand-new wording',
      new Headers(),
    );

    expect(isPreviousResponseIdError(err)).toBe(true);
  });

  it('recognizes a nested error.param (e.g. a WebSocket error wrapper)', () => {
    const err = new Error('response.create rejected') as Error & {
      error?: unknown;
    };
    err.error = { param: 'previous_response_id', message: 'invalid' };

    expect(isPreviousResponseIdError(err)).toBe(true);
  });

  it('falls back to message matching for a 404 with no param (missing resource, not an invalid parameter)', () => {
    const err = new OpenAINotFoundError(
      404,
      { message: "Previous response with id 'resp_123' not found." },
      "Previous response with id 'resp_123' not found.",
      new Headers(),
    );

    expect(isPreviousResponseIdError(err)).toBe(true);
  });

  it('does not match an unrelated invalid-parameter error', () => {
    const err = new OpenAIBadRequestError(
      400,
      { param: 'temperature', message: 'temperature must be between 0 and 2' },
      'temperature must be between 0 and 2',
      new Headers(),
    );

    expect(isPreviousResponseIdError(err)).toBe(false);
  });
});

describe('provider error schemas', () => {
  it('normalizes legacy retryable fields from persisted error logs', () => {
    const errorLog = ErrorLogDataSchema.parse({
      message: 'old persisted error',
      retryable: false,
      isRelayError: false,
    });
    const retryInfo = RetryErrorInfoSchema.parse({
      message: 'old retry state',
      retryable: true,
    });

    expect(errorLog.userRetryable).toBe(false);
    expect('retryable' in errorLog).toBe(false);
    expect(retryInfo.userRetryable).toBe(true);
  });

  it('migrates legacy exhaustion booleans persisted by older TeXRA versions', () => {
    // Stream logs are unversioned JSON reparsed on later loads (see
    // StreamLogStore) — a record written before the exhaustionReason
    // refactor still carries the independent boolean flags.
    const chatgptLegacy = ErrorLogDataSchema.parse({
      message: 'legacy chatgpt-subscription record',
      userRetryable: true,
      isCredentialExhausted: true,
      isChatGptSubscriptionLimited: true,
    });
    expect(chatgptLegacy.exhaustionReason).toBe('chatgpt-subscription');
    expect('isCredentialExhausted' in chatgptLegacy).toBe(false);
    expect('isChatGptSubscriptionLimited' in chatgptLegacy).toBe(false);

    const upstreamLegacy = RetryErrorInfoSchema.parse({
      message: 'legacy upstream-credit record',
      userRetryable: true,
      isCredentialExhausted: true,
      isUpstreamCreditDepleted: true,
    });
    expect(upstreamLegacy.exhaustionReason).toBe('upstream-credit');

    const relayLimitLegacy = RetryErrorInfoSchema.parse({
      message: 'legacy relay-limit record',
      userRetryable: true,
      isCredentialExhausted: true,
    });
    expect(relayLimitLegacy.exhaustionReason).toBe('relay-limit');

    const noExhaustionLegacy = RetryErrorInfoSchema.parse({
      message: 'legacy non-exhausted record',
      userRetryable: true,
      isCredentialExhausted: false,
    });
    expect(noExhaustionLegacy.exhaustionReason).toBeUndefined();
  });
});

describe('toRetryErrorInfo / attach-as-ProviderError round-trip', () => {
  const fullProviderError: ProviderError = {
    message: 'HTTP 429 Too Many Requests – rate limited',
    userRetryable: true,
    isRelayError: true,
    statusCode: 429,
    statusText: 'Too Many Requests',
    provider: 'anthropic',
    exhaustionReason: 'relay-limit',
    requestId: 'req_abc123',
    streamDiagnostics: {
      thinkingChars: 100,
      textChars: 200,
      toolInputChars: 0,
      blockTypesSeen: ['text', 'thinking'],
      eventsProcessed: 15,
      lastEventType: 'content_block_stop',
      elapsedSecs: 2.5,
      secsSinceLastEvent: 0.1,
      finalized: false,
      messageStartReceived: true,
      messageStopReceived: false,
      stopReason: null,
      anthropicMessageId: 'msg_01ABC',
    },
    partialText: 'Here is the analysis of the',
  };

  it('preserves statusCode, provider, and relay flags through the round-trip', () => {
    const reconstructed: ProviderError = toRetryErrorInfo(fullProviderError);

    expect(reconstructed.statusCode).toBe(429);
    expect(reconstructed.provider).toBe('anthropic');
    expect(reconstructed.isRelayError).toBe(true);
    expect(reconstructed.exhaustionReason).toBe('relay-limit');
    expect(reconstructed.requestId).toBe('req_abc123');
    expect(reconstructed.userRetryable).toBe(true);
  });

  it('preserves stream diagnostics and partial text through the round-trip', () => {
    const reconstructed: ProviderError = toRetryErrorInfo(fullProviderError);

    expect(reconstructed.streamDiagnostics?.eventsProcessed).toBe(15);
    expect(reconstructed.streamDiagnostics?.anthropicMessageId).toBe(
      'msg_01ABC',
    );
    expect(reconstructed.partialText).toBe('Here is the analysis of the');
  });

  it('omits rawErrorBody from the RetryErrorInfo record', () => {
    const info = toRetryErrorInfo(fullProviderError);

    // rawErrorBody is intentionally excluded from RetryErrorInfo (large,
    // not worth persisting). Verify the schema doesn't carry it.
    expect('rawErrorBody' in info).toBe(false);
  });
});

describe('attachProviderError end-to-end', () => {
  it('surfaces a cached ProviderError with statusCode and provider via normalizeProviderError', () => {
    // Simulates what happens at the flow rethrow: the RetryErrorInfo is
    // attached as-is, attachProviderError caches it, then
    // normalizeProviderError recovers it downstream.
    const retryInfo: RetryErrorInfo = {
      message: 'HTTP 429 Too Many Requests – rate limited',
      userRetryable: true,
      statusCode: 429,
      provider: 'anthropic',
      isRelayError: true,
    };

    const err = new Error(retryInfo.message);
    attachProviderError(err, retryInfo);

    const recovered = normalizeProviderError(err);

    expect(recovered.statusCode).toBe(429);
    expect(recovered.provider).toBe('anthropic');
    expect(recovered.isRelayError).toBe(true);
    expect(recovered.userRetryable).toBe(true);
    expect(normalizeProviderError(err)).toBe(recovered);
  });

  it('recovers cached ProviderError data through wrapper causes', () => {
    const retryInfo: RetryErrorInfo = {
      message: 'HTTP 503 Service Unavailable – server overloaded',
      userRetryable: true,
      statusCode: 503,
      provider: 'anthropic',
      requestId: 'req_wrapped_503',
    };

    const cause = new Error(retryInfo.message);
    attachProviderError(cause, retryInfo);
    const wrapper = new Error('Tool-use flow failed', { cause });

    expect(getSdkErrorMessage(wrapper)).toBe(retryInfo.message);

    const logData = buildErrorLogData(wrapper, {
      operation: 'execute orchestrator',
    });

    expect(logData.statusCode).toBe(503);
    expect(logData.provider).toBe('anthropic');
    expect(logData.requestId).toBe('req_wrapped_503');
    expect(logData.rawMessage).toBe('Tool-use flow failed');
    expect(logData.operation).toBe('execute orchestrator');
    expect(normalizeProviderError(wrapper)).toBe(retryInfo);
  });

  it('migrates legacy fields on a cached ProviderError instead of returning them unchanged', () => {
    // Simulates a cached error attached before the retryable/exhaustion-flag
    // migration ran — e.g. a resumed tool-use flow's raw persisted
    // `lastError`, which bypasses the schema-level migration on that resume
    // path (migrateSharedState casts the persisted shape directly).
    const legacyCached = {
      message: 'legacy relay-limit record',
      retryable: true,
      isCredentialExhausted: true,
    } as unknown as ProviderError;

    const err = new Error(legacyCached.message);
    attachProviderError(err, legacyCached);

    const recovered = normalizeProviderError(err);

    expect(recovered.userRetryable).toBe(true);
    expect(recovered.exhaustionReason).toBe('relay-limit');
    expect('retryable' in recovered).toBe(false);
    expect('isCredentialExhausted' in recovered).toBe(false);
    expect(recovered.exhaustionReason !== undefined).toBe(true);
  });
});
