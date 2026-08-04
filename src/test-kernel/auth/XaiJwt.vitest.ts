import { describe, expect, it } from 'vitest';

import {
  accessTokenIsExpiring,
  decodeXaiJwtClaims,
  extractXaiClaims,
} from '@auth/xai';

function makeJwt(payload: object): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('xAI JWT claim helpers', () => {
  it('extracts email and exp from a well-formed access token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = decodeXaiJwtClaims(
      makeJwt({ email: 'user@example.com', exp }),
    );
    expect(claims.email).toBe('user@example.com');
    expect(claims.expiresAtMs).toBe(exp * 1000);
  });

  it('prefers id_token email over access_token', () => {
    const claims = extractXaiClaims(
      makeJwt({ email: 'id@example.com' }),
      makeJwt({ email: 'access@example.com' }),
    );
    expect(claims.email).toBe('id@example.com');
  });

  it('detects expiring JWTs within the skew window', () => {
    const nearExpiry = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 });
    expect(accessTokenIsExpiring(nearExpiry, Date.now(), 60_000)).toBe(true);
    expect(accessTokenIsExpiring(nearExpiry, Date.now(), 0)).toBe(false);
  });

  it('returns false for opaque tokens', () => {
    expect(accessTokenIsExpiring('opaque-token', Date.now(), 60_000)).toBe(
      false,
    );
    expect(decodeXaiJwtClaims('not-a-jwt')).toEqual({});
  });
});
