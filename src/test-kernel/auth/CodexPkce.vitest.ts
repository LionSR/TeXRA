import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateOAuthState,
  generatePkcePair,
} from '@auth/codex';
import { isCodexSubscriptionEligible } from '@model/providerCapabilities';

/** A minimal OpenAI `ModelConfig` fixture, overridable per test. */
function openAIModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'test-model',
    label: 'Test Model',
    fullName: 'gpt-test',
    shortName: 'gpt-test',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 128_000,
    inputPrice: 1,
    outputPrice: 1,
    contextWindow: 400_000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
    ...overrides,
  };
}

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
  it('accepts current top-reasoning-effort OpenAI models', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.5-2026-04-23',
          shortName: 'gpt-5.5',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(true);
  });

  it('accepts date-pinned variants of curated models', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.5-2026-04-23',
          shortName: '',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(true);
  });

  it('accepts any codex-named model regardless of reasoning effort (future-proof)', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({ fullName: 'gpt-5.9-codex', shortName: 'gpt-5.9-codex' }),
      ),
    ).toBe(true);
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-6-codex-mini',
          shortName: 'gpt-6-codex-mini',
        }),
      ),
    ).toBe(true);
  });

  it('rejects models that are not top reasoning-effort tier', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({ fullName: 'gpt-4.1', shortName: 'gpt-4.1' }),
      ),
    ).toBe(false);
  });

  it('rejects a top-reasoning-effort model that has been retired', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.2-2025-12-11',
          shortName: 'gpt-5.2',
          retired: true,
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(false);
  });

  // #7192: the eligibility check must not depend on a hand-maintained
  // fullName allowlist. `gpt-5.6` never existed in that old list and doesn't
  // match the `/codex/i` naming convention either, so this can only pass if
  // eligibility is genuinely derived from registry capability data (top
  // reasoning-effort tier, live, not deprecated) rather than enumeration.
  it('accepts a future top-reasoning-effort model absent from any hardcoded list', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.6-2026-08-01',
          shortName: 'gpt-5.6',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(true);
  });
});
