import { describe, expect, it } from 'vitest';

import { extractCodexClaims } from '@auth/codex';

/** Build a JWT with the given payload (signature is irrelevant — we only decode). */
function makeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}

describe('codex JWT claim extraction', () => {
  it('reads the top-level chatgpt_account_id', () => {
    const jwt = makeJwt({ chatgpt_account_id: 'acct-top', email: 'a@b.com' });
    expect(extractCodexClaims(jwt, undefined)).toEqual({
      accountId: 'acct-top',
      email: 'a@b.com',
    });
  });

  it('reads the nested https://api.openai.com/auth claim', () => {
    const jwt = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-nested' },
      email: 'nested@b.com',
    });
    expect(extractCodexClaims(jwt, undefined)).toEqual({
      accountId: 'acct-nested',
      email: 'nested@b.com',
    });
  });

  it('falls back to organizations[0].id', () => {
    const jwt = makeJwt({
      organizations: [{ id: 'org-123' }, { id: 'org-456' }],
    });
    expect(extractCodexClaims(jwt, undefined).accountId).toBe('org-123');
  });

  it('prefers the id_token over the access_token', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'from-id-token' });
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' });
    expect(extractCodexClaims(idToken, accessToken).accountId).toBe(
      'from-id-token',
    );
  });

  it('falls back to the access_token when id_token is absent', () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' });
    expect(extractCodexClaims(undefined, accessToken).accountId).toBe(
      'from-access-token',
    );
  });

  it('falls back field-by-field when id_token lacks claims', () => {
    const idToken = makeJwt({ email: 'from-id-token@example.com' });
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' });
    expect(extractCodexClaims(idToken, accessToken)).toEqual({
      accountId: 'from-access-token',
      email: 'from-id-token@example.com',
    });
  });

  it('falls back to access_token when id_token is malformed', () => {
    const accessToken = makeJwt({
      chatgpt_account_id: 'from-access-token',
      email: 'from-access-token@example.com',
    });
    expect(extractCodexClaims('not-a-jwt', accessToken)).toEqual({
      accountId: 'from-access-token',
      email: 'from-access-token@example.com',
    });
  });

  it('keeps a valid claim when a sibling claim is malformed', () => {
    // A wrong-typed / garbage sibling must degrade to undefined on its own
    // rather than dropping the whole payload (per-field tolerance).
    const jwt = makeJwt({
      chatgpt_account_id: 'acct-top',
      organizations: 'garbage',
      email: 123,
    });
    expect(extractCodexClaims(jwt, undefined)).toEqual({
      accountId: 'acct-top',
    });
  });

  it('returns empty claims for malformed or missing tokens', () => {
    expect(extractCodexClaims(undefined, undefined)).toEqual({});
    expect(extractCodexClaims('not-a-jwt', undefined)).toEqual({});
    expect(extractCodexClaims('a.!!!notbase64json!!!.c', undefined)).toEqual(
      {},
    );
  });
});
