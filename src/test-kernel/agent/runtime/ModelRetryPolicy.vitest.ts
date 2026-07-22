// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  classifyModelRouteFailure,
  modelRetryRoute,
} from '@agent/core/flows/modelRetryPolicy';

describe('model retry policy', () => {
  it('coordinates one endpoint and credential route independently of model', () => {
    const first = modelRetryRoute({
      provider: 'openai',
      credentialRoute: 'chatgpt-subscription',
      endpoint: 'https://chatgpt.com/backend-api/codex',
    });
    const second = modelRetryRoute({
      provider: 'openai',
      credentialRoute: 'chatgpt-subscription',
      endpoint: 'https://chatgpt.com/backend-api/codex',
    });

    expect(second).toBe(first);
  });

  it('does not couple separate custom endpoints', () => {
    const first = modelRetryRoute({
      provider: 'openai',
      credentialRoute: 'api-key',
      endpoint: 'https://first.example/v1',
    });
    const second = modelRetryRoute({
      provider: 'openai',
      credentialRoute: 'api-key',
      endpoint: 'https://second.example/v1',
    });

    expect(second).not.toBe(first);
  });

  it('recognizes a nested Undici transport failure', () => {
    const transport = Object.assign(
      new Error('HTTP/2: "stream timeout after 300000"'),
      { code: 'UND_ERR_INFO' },
    );
    const fetchError = new TypeError('fetch failed', { cause: transport });
    const sdkError = new Error('Connection error', { cause: fetchError });

    expect(classifyModelRouteFailure(sdkError)).toEqual({
      retryAfterMs: undefined,
    });
  });

  it('keeps unrelated programming errors local to their invocation', () => {
    expect(
      classifyModelRouteFailure(new Error('unexpected response invariant')),
    ).toBeUndefined();
  });

  it('honors provider retry-after guidance for shared HTTP failures', () => {
    const error = Object.assign(new Error('busy'), {
      status: 503,
      headers: { 'retry-after': '12' },
    });

    expect(classifyModelRouteFailure(error)).toEqual({ retryAfterMs: 12_000 });
  });

  it('classifies an HTTP conflict as a shared transient failure', () => {
    const error = Object.assign(new Error('conflict'), { status: 409 });

    expect(classifyModelRouteFailure(error)).toEqual({
      retryAfterMs: undefined,
    });
  });
});
