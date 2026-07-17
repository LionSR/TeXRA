import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPlatform } from '@test/support/setupPlatform';
import {
  KIMI_CODE_CLIENT_ID,
  KIMI_CODE_DEVICE_AUTHORIZATION_URL,
  KIMI_CODE_TOKEN_URL,
  pollDeviceToken,
  refreshTokens,
  requestDeviceUserCode,
} from '@auth/kimiCode';

const MSH_HEADER_NAMES = [
  'X-Msh-Platform',
  'X-Msh-Version',
  'X-Msh-Device-Name',
  'X-Msh-Device-Model',
  'X-Msh-Os-Version',
  'X-Msh-Device-Id',
] as const;

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    json: async () => data,
  } as unknown as Response;
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function sentRequest(call = 0): {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
} {
  const [url, init] = fetchMock.mock.calls[call];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: new URLSearchParams(String(init.body)),
  };
}

/** Every token/device-authorization request must carry the device headers. */
function expectMshHeaders(call = 0): Record<string, string> {
  const { headers } = sentRequest(call);
  for (const name of MSH_HEADER_NAMES) {
    expect(headers[name], name).toEqual(expect.any(String));
    expect(headers[name].length, name).toBeGreaterThan(0);
  }
  expect(headers['X-Msh-Platform']).toBe('texra');
  return headers;
}

describe('Kimi Code OAuth client', () => {
  beforeEach(async () => {
    await installPlatform();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests a device user code with the device headers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri_complete: 'https://auth.kimi.com/activate?code=1',
        // The endpoint may send the interval as a string; the schema coerces.
        interval: '7',
      }),
    );

    const result = await requestDeviceUserCode();

    expect(result.device_code).toBe('device-code');
    expect(result.user_code).toBe('USER-CODE');
    expect(result.interval).toBe(7);

    const { url, body } = sentRequest();
    expect(url).toBe(KIMI_CODE_DEVICE_AUTHORIZATION_URL);
    expect(body.get('client_id')).toBe(KIMI_CODE_CLIENT_ID);
    expectMshHeaders();
  });

  it('classifies a completed poll as success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    );

    const result = await pollDeviceToken('device-code');

    expect(result).toEqual({
      kind: 'success',
      token: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    });

    const { url, body } = sentRequest();
    expect(url).toBe(KIMI_CODE_TOKEN_URL);
    expect(body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(body.get('device_code')).toBe('device-code');
    expectMshHeaders();
  });

  it('classifies authorization_pending as pending', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'authorization_pending' }),
    );
    await expect(pollDeviceToken('device-code')).resolves.toEqual({
      kind: 'pending',
      errorCode: 'authorization_pending',
      description: 'authorization_pending',
    });
    expectMshHeaders();
  });

  it('classifies slow_down as pending with its error code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'slow_down',
        error_description: 'Polling too fast',
      }),
    );
    await expect(pollDeviceToken('device-code')).resolves.toEqual({
      kind: 'pending',
      errorCode: 'slow_down',
      description: 'Polling too fast',
    });
  });

  it('classifies expired_token as expired', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'expired_token' }),
    );
    await expect(pollDeviceToken('device-code')).resolves.toEqual({
      kind: 'expired',
    });
  });

  it('classifies access_denied as denied', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'access_denied',
        error_description: 'User rejected the request',
      }),
    );
    await expect(pollDeviceToken('device-code')).resolves.toEqual({
      kind: 'denied',
      description: 'User rejected the request',
    });
  });

  it('throws a transient error on a 5xx poll response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    await expect(pollDeviceToken('device-code')).rejects.toMatchObject({
      name: 'KimiCodeAuthError',
      kind: 'transient',
      status: 500,
      needsReauth: false,
    });
  });

  it('throws a fatal error on an unknown 400 poll error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'bogus_error' }),
    );
    await expect(pollDeviceToken('device-code')).rejects.toMatchObject({
      name: 'KimiCodeAuthError',
      kind: 'fatal',
      status: 400,
      needsReauth: true,
    });
  });

  it('refreshes tokens with a refresh_token grant and the device headers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'access-next',
        refresh_token: 'refresh-next',
        expires_in: 1800,
      }),
    );

    const tokens = await refreshTokens('refresh-prev');

    expect(tokens).toEqual({
      access_token: 'access-next',
      refresh_token: 'refresh-next',
      expires_in: 1800,
    });

    const { url, body } = sentRequest();
    expect(url).toBe(KIMI_CODE_TOKEN_URL);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-prev');
    expect(body.get('client_id')).toBe(KIMI_CODE_CLIENT_ID);
    expectMshHeaders();
  });

  it('throws a fatal error on a 401 refresh rejection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error_description: 'Refresh token revoked' }),
    );
    await expect(refreshTokens('refresh-prev')).rejects.toMatchObject({
      name: 'KimiCodeAuthError',
      kind: 'fatal',
      status: 401,
      needsReauth: true,
    });
    expectMshHeaders();
  });

  it('sends the same persisted device id on sequential requests', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: 'authorization_pending' }),
    );

    await pollDeviceToken('device-code');
    await pollDeviceToken('device-code');

    const first = expectMshHeaders(0);
    const second = expectMshHeaders(1);
    expect(second['X-Msh-Device-Id']).toBe(first['X-Msh-Device-Id']);
  });
});
