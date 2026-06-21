/**
 * PKCE (RFC 7636) + CSRF-state generation for the Codex OAuth flow.
 *
 * The Supabase flow delegates PKCE to the Supabase JS SDK; Codex has no SDK
 * doing this, so we hand-roll it with node:crypto. Mirrors Zed's
 * `do_oauth_flow` (32-byte verifier, S256 challenge) and the Codex CLI.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  /** The high-entropy secret carried through the loopback round-trip. */
  verifier: string;
  /** base64url(SHA-256(verifier)) sent in the authorize request. */
  challenge: string;
  /** Always S256 — the only method the Codex client accepts. */
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

/** Random CSRF state value (base64url). */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}
