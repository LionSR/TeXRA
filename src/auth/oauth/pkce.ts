/**
 * PKCE (RFC 7636) + CSRF-state generation for subscription OAuth flows
 * (ChatGPT/Codex, Grok/xAI, …). Shared so providers do not re-roll crypto.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  /** The high-entropy secret carried through the loopback round-trip. */
  verifier: string;
  /** base64url(SHA-256(verifier)) sent in the authorize request. */
  challenge: string;
  /** Always S256. */
  method: 'S256';
}

/** 32 random bytes, base64url (no padding). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** base64url(SHA-256(verifier)), no padding. */
export function computeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A fresh PKCE pair (verifier + S256 challenge). */
export function generatePkcePair(): PkcePair {
  const verifier = generateCodeVerifier();
  return {
    verifier,
    challenge: computeCodeChallenge(verifier),
    method: 'S256',
  };
}

/** Random CSRF state or OIDC nonce (base64url). */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}
