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
  attachContextWindowError,
  attachMissingApiKeyError,
  attachProviderError,
} from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isUserAbort,
} from '@common/errors/sdkError/errorPatterns';
import { detectStatusText } from '@common/errors/sdkError/errorInspection';
import {
  buildErrorLogData,
  formatProviderHttpError,
  getSdkErrorMessage,
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import {
  ProviderErrorPartialSchema,
  RetryErrorInfoSchema,
  toRetryErrorInfo,
} from '@shared/schemas';
import type { ProviderError, RetryErrorInfo } from '@shared/schemas';

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

  it('formats OpenAI connection errors with existing retry behavior', () => {
    const error = new OpenAIAPIConnectionTimeoutError();

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

    expect(formatProviderHttpError(codeOnlyError).statusCode).toBe(503);
  });

  it('keeps unknown status-less OpenAI API errors non-retryable', () => {
    const body = {
      type: 'unexpected_error',
      code: 'unexpected_error',
      message: 'Unexpected provider failure.',
    };
    const error = new OpenAIAPIError(undefined, body, body.message, undefined);

    const formatted = formatProviderHttpError(error);

    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats OpenAI HTTP errors with status metadata', () => {
    const error = new OpenAIBadRequestError(
      400,
      { message: 'bad payload' },
      'bad payload',
      new Headers([['x-request-id', 'req_123']]),
    );

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

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe('HTTP 400 Bad Request – Bad Request');
    expect(formatted.message).not.toContain(privatePrompt);
    expect(formatted.message).not.toContain('opaque credential');
    expect(formatted.rawErrorBody).toEqual(body);
  });

  it('does not promote a serialized plain-text response body into the message', () => {
    const privateBody = 'private prompt and opaque authorization';
    const error = new OpenAIBadRequestError(
      400,
      privateBody,
      'ignored by the OpenAI error constructor',
      new Headers(),
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.message).toBe('HTTP 400 Bad Request – Bad Request');
    expect(formatted.message).not.toContain(privateBody);
    expect(formatted.rawErrorBody).toBe(privateBody);
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
    expect(formatted.classification).toStrictEqual({ kind: 'upstream-credit' });
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
    expect(formatted.classification).toBeUndefined();
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

  it('formats Anthropic user abort errors', () => {
    const error = new AnthropicAPIUserAbortError();

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.message).toBe('Request aborted');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats Anthropic HTTP errors with status-derived metadata', () => {
    const error = new AnthropicAuthenticationError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid key' },
      },
      'invalid key',
      new Headers([['request-id', 'req_anthropic']]),
    );

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.statusCode).toBe(401);
    expect(formatted.statusText).toBe('Unauthorized');
    expect(formatted.message).toContain('HTTP 401 Unauthorized');
    expect(formatted.message).toContain('invalid key');
    expect(formatted.requestId).toBe('req_anthropic');
    expect(formatted.userRetryable).toBe(false);
  });
});

describe('provider marker classification', () => {
  it('formats a missing API key marker as the aligned agent-error kind', () => {
    const err = new Error('provider-specific credential wording');
    attachMissingApiKeyError(err);

    expect(formatProviderHttpError(err).classification).toStrictEqual({
      kind: 'missing-api-key',
    });
  });
});

describe('isContextWindowError', () => {
  it('recognizes a TeXRA-internal throw via its typed marker, independent of wording', () => {
    // run/modelFailure.ts tags its own throw with
    // attachContextWindowError() instead of relying on isContextWindowError
    // string-matching the exact message it owns.
    const err = new Error(
      'Token count of message exceeds context window: 5 > 3',
    );
    attachContextWindowError(err);

    expect(isContextWindowError(err)).toBe(true);
    expect(formatProviderHttpError(err).classification).toStrictEqual({
      kind: 'context-window',
    });
  });

  it('still recognizes the marker after the internal message wording changes', () => {
    // The marker decouples classification from message text: even if
    // the thrower reworks its wording entirely, the marker still matches.
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

describe('provider error schemas', () => {
  it('rejects a malformed canonical classification', () => {
    expect(() =>
      RetryErrorInfoSchema.parse({
        message: 'malformed canonical classification',
        userRetryable: false,
        classification: { kind: 'not-a-provider-kind' },
      }),
    ).toThrow();
  });
});

describe('toRetryErrorInfo / attach-as-ProviderError round-trip', () => {
  const fullProviderError: ProviderError = {
    message: 'HTTP 429 Too Many Requests – rate limited',
    userRetryable: true,
    statusCode: 429,
    statusText: 'Too Many Requests',
    provider: 'anthropic',
    classification: { kind: 'upstream-credit' },
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

  it('preserves statusCode, provider, and exhaustion reason through the round-trip', () => {
    const reconstructed: ProviderError = toRetryErrorInfo(fullProviderError);

    expect(reconstructed.statusCode).toBe(429);
    expect(reconstructed.provider).toBe('anthropic');
    expect(reconstructed.classification).toStrictEqual({
      kind: 'upstream-credit',
    });
    expect(reconstructed.requestId).toBe('req_abc123');
    expect(reconstructed.userRetryable).toBe(true);
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
    };

    const err = new Error(retryInfo.message);
    attachProviderError(err, retryInfo);

    const recovered = normalizeProviderError(err);

    expect(recovered.statusCode).toBe(429);
    expect(recovered.provider).toBe('anthropic');
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

  it('ignores malformed current ProviderError metadata', () => {
    const malformed = {
      message: 'mixed provider metadata',
      userRetryable: true,
      classification: { kind: 'context-window' },
      missingApiKey: true,
    } as unknown as ProviderError;
    const err = new Error(malformed.message);
    attachProviderError(err, malformed);

    const recovered = normalizeProviderError(err);

    expect(recovered).not.toBe(malformed);
    expect(recovered.classification).toBeUndefined();
  });
});
