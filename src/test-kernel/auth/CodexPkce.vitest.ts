import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateOAuthState,
  generatePkcePair,
  isCodexSubscriptionEligible,
} from '@auth/codex';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('codex PKCE', () => {
  it('generates a base64url verifier with no padding', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).not.toContain('=');
    // 32 random bytes → 43 base64url chars.
    expect(verifier.length).toBe(43);
  });

  it('derives the challenge as base64url(SHA-256(verifier))', () => {
    const verifier = 'fixed-test-verifier-value';
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(computeCodeChallenge(verifier)).toBe(expected);
    expect(computeCodeChallenge(verifier)).toMatch(BASE64URL);
  });

  it('produces a matching S256 pair', () => {
    const pair = generatePkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.challenge).toBe(computeCodeChallenge(pair.verifier));
  });

  it('generates unique verifiers and states', () => {
    const verifiers = new Set(
      Array.from({ length: 32 }, () => generateCodeVerifier()),
    );
    expect(verifiers.size).toBe(32);
    const states = new Set(
      Array.from({ length: 32 }, () => generateOAuthState()),
    );
    expect(states.size).toBe(32);
  });
});

describe('codex model eligibility', () => {
  it('accepts the curated subscription models', () => {
    expect(isCodexSubscriptionEligible('gpt-5.5')).toBe(true);
    expect(isCodexSubscriptionEligible('gpt-5.4-mini')).toBe(true);
  });

  it('accepts any codex-named model (future-proof)', () => {
    expect(isCodexSubscriptionEligible('gpt-5.9-codex')).toBe(true);
    expect(isCodexSubscriptionEligible('gpt-6-codex-mini')).toBe(true);
  });

  it('rejects unrelated models', () => {
    expect(isCodexSubscriptionEligible('gpt-4.1')).toBe(false);
    expect(isCodexSubscriptionEligible('claude-opus-4-8')).toBe(false);
  });
});
