import { describe, expect, it } from 'vitest';

import { decodeXaiJwtClaims } from '@auth/xai';

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

  it('returns empty claims for opaque tokens', () => {
    expect(decodeXaiJwtClaims('not-a-jwt')).toEqual({});
  });
});
