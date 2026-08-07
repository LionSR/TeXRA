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
} from '@auth/oauth/pkce';
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
    const challenge = computeCodeChallenge(verifier);
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(BASE64URL);
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
  // Serving status is registry data: llm-zoo's `codexSubscription` flag,
  // sourced from the Codex CLI's embedded model manifest cross-checked
  // against https://developers.openai.com/codex/models. The registry-derived
  // heuristic this replaced (top reasoning-effort tier / `codex` naming /
  // deprecation exceptions) inferred serving status from proxies and broke
  // when they diverged: GPT-5.6 ships with a `medium` default effort, failed
  // the tier gate, and silently fell back to the user's API key.
  it.each<{ name: string; overrides: Partial<ModelConfig>; eligible: boolean }>(
    [
      {
        name: 'accepts an OpenAI model the registry flags as Codex-served',
        overrides: {
          fullName: 'gpt-5.6-sol',
          shortName: 'gpt-5.6',
          codexSubscription: true,
        },
        eligible: true,
      },
      {
        // GPT-5.6's registry default effort is medium — the exact case the old
        // top-tier heuristic misrouted to the API-key path.
        name: 'accepts a flagged model regardless of reasoning-effort tier',
        overrides: {
          fullName: 'gpt-5.6-sol',
          shortName: 'gpt-5.6',
          codexSubscription: true,
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.MEDIUM,
          },
        },
        eligible: true,
      },
      {
        // gpt-5.5 is marked deprecated in the registry but the Codex backend
        // still serves it — the flag records serving status directly, so no
        // deprecated-exception table is needed.
        name: 'accepts a flagged model regardless of deprecation status',
        overrides: {
          fullName: 'gpt-5.5-2026-04-23',
          shortName: 'gpt-5.5',
          deprecated: true,
          codexSubscription: true,
        },
        eligible: true,
      },
      {
        // Top reasoning tier + `codex` name + live: everything the old heuristic
        // trusted. Absent the registry flag, it must not route to Codex.
        name: 'rejects an unflagged model even when every old-heuristic proxy matches',
        overrides: {
          fullName: 'gpt-5.9-codex',
          shortName: 'gpt-5.9-codex',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.MAX,
          },
        },
        eligible: false,
      },
      {
        name: 'rejects the API-only gpt-5.4-nano (unflagged in the registry)',
        overrides: {
          fullName: 'gpt-5.4-nano-2026-03-17',
          shortName: 'gpt-5.4-nano',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        },
        eligible: false,
      },
      {
        // The provider guard must live inside the function itself, not only in
        // callers — a non-OpenAI ModelConfig must never resolve eligible, even if
        // a future registry mistake flags one.
        name: 'rejects a non-OpenAI model even when flagged',
        overrides: {
          provider: ModelProvider.ANTHROPIC,
          fullName: 'claude-codex-lookalike',
          shortName: 'claude-codex-lookalike',
          codexSubscription: true,
        },
        eligible: false,
      },
    ],
  )('$name', ({ overrides, eligible }) => {
    expect(isCodexSubscriptionEligible(openAIModel(overrides))).toBe(eligible);
  });
});
