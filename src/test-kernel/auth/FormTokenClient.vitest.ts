import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  exchangeAuthorizationCode,
  oauthTokenErrorKind,
  refreshOAuthTokens,
  type OAuthFormEndpoint,
} from '@auth/oauth/formTokenClient';
import { decodeJwtClaimsWithSchema } from '@auth/oauth/jwtDecode';

class TestAuthError extends Error {
  readonly kind: 'fatal' | 'expired' | 'transient' | 'config' | 'pending';
  readonly status?: number;

  constructor(
    message: string,
    kind: TestAuthError['kind'],
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TestAuthError';
    this.kind = kind;
    this.status = status;
  }
}

const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().min(1).nullish(),
  expires_in: z.number(),
});

const ENDPOINT: OAuthFormEndpoint<z.infer<typeof TokenSchema>> = {
  tokenUrl: 'https://example.test/token',
  clientId: 'client-1',
  ErrorType: TestAuthError,
  tokenResponseSchema: TokenSchema,
};

describe('form token endpoint (declarative)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetchJson(payload: unknown) {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('exchanges an authorization code via form body', async () => {
    const fetchMock = stubFetchJson({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
    });

    const tokens = await exchangeAuthorizationCode(ENDPOINT, {
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1/callback',
    });

    expect(tokens.access_token).toBe('access');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.test/token');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1/callback');
  });

  it('refreshes with the refresh_token grant', async () => {
    const fetchMock = stubFetchJson({
      access_token: 'new-access',
      expires_in: 1800,
    });

    const tokens = await refreshOAuthTokens(ENDPOINT, 'old-refresh');
    expect(tokens.access_token).toBe('new-access');
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
  });

  it('maps 401 token errors to fatal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );

    await expect(refreshOAuthTokens(ENDPOINT, 'bad')).rejects.toMatchObject({
      name: 'TestAuthError',
      kind: 'fatal',
      status: 401,
    });
  });
});

describe('oauthTokenErrorKind', () => {
  it.each([
    [400, 'fatal'],
    [401, 'fatal'],
    [403, 'fatal'],
    [429, 'transient'],
    [500, 'transient'],
  ] as const)('treats status %i as %s', (status, kind) => {
    expect(oauthTokenErrorKind(status)).toBe(kind);
  });
});

describe('decodeJwtClaimsWithSchema', () => {
  const schema = z.object({ email: z.string() });

  it('decodes a well-formed JWT payload through the schema', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@b.com' })).toString(
      'base64url',
    );
    const token = `h.${payload}.s`;
    expect(decodeJwtClaimsWithSchema(token, schema, { email: '' })).toEqual({
      email: 'a@b.com',
    });
  });

  it('returns empty on malformed tokens', () => {
    expect(
      decodeJwtClaimsWithSchema('not-a-jwt', schema, { email: '' }),
    ).toEqual({ email: '' });
  });
});
