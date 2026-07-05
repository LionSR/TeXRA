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

  // #7223: ReasoningEffort has a tier above XHIGH (MAX, clamped to 'xhigh' on
  // the OpenAI wire by toOpenAIReasoningEffort) — a registry model reporting
  // MAX must resolve eligible too, not just XHIGH.
  it('accepts a MAX-reasoning-effort OpenAI model', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.7-2026-09-01',
          shortName: 'gpt-5.7',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.MAX,
          },
        }),
      ),
    ).toBe(true);
  });

  // #7223: a non-OpenAI ModelConfig must never resolve eligible even if its
  // reasoningEffort/id would otherwise match — the provider guard must live
  // inside the function itself, not only in callers.
  it('rejects a non-OpenAI model even at top reasoning-effort tier', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          provider: ModelProvider.ANTHROPIC,
          fullName: 'claude-codex-lookalike',
          shortName: 'claude-codex-lookalike',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(false);
  });

  // #7223: gpt-5.4-nano is OpenAI + XHIGH + live per the llm-zoo registry, so
  // the naive heuristic marks it eligible, but it's an API-only variant the
  // Codex backend does not actually serve — routing it there would fail at
  // request time instead of using the normal API-key path.
  it('rejects the gpt-5.4-nano false positive despite matching the heuristic', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.4-nano-2026-03-17',
          shortName: 'gpt-5.4-nano',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(false);
  });

  // #7223: gpt-5.4 is deprecated (superseded by gpt-5.5) but the Codex
  // backend still actually serves it — the old hardcoded allowlist this
  // heuristic replaced still routed it through the ChatGPT subscription, so
  // a bare deprecated-excludes-all rule would be a real regression.
  it('accepts the deprecated-but-still-served gpt-5.4 false negative', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.4-2026-03-05',
          shortName: 'gpt-5.4',
          deprecated: true,
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(true);
  });

  // A deprecated model *not* on the known-served exception list still gets
  // excluded by default — the exception table is narrow, not a blanket
  // "deprecated no longer disqualifies" change.
  it('still rejects an ordinary deprecated model outside the known exception list', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.2-2025-12-11',
          shortName: 'gpt-5.2',
          deprecated: true,
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(false);
  });

  // #7223 follow-up: the `retired` guard must apply uniformly regardless of
  // which branch would otherwise resolve eligibility. A `-codex`-named model
  // (e.g. gpt-5.2-codex, pulled after gpt-5.3-codex ships) must be rejected
  // once retired — the naming convention must not let a pulled model bypass
  // the same "no longer served" check a same-retired non-codex-named model
  // correctly fails.
  it('rejects a retired codex-named model despite matching the naming convention', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.2-codex-2025-12-11',
          shortName: 'gpt-5.2-codex',
          retired: true,
        }),
      ),
    ).toBe(false);
  });

  // #7223 round 3: the old hardcoded `CODEX_SUBSCRIPTION_MODEL_FULLNAMES`
  // allowlist also listed `gpt-5.4-mini` as Codex-eligible. This exception is
  // added defensively to `CODEX_DEPRECATED_EXCEPTIONS` even though the live
  // llm-zoo registry doesn't currently mark it deprecated, so a future
  // registry update marking it deprecated (once gpt-5.5 or a successor fully
  // supersedes it) can't silently regress its eligibility the way `gpt-5.4`
  // itself would have without an exception entry.
  it('accepts the deprecated-but-still-served gpt-5.4-mini false negative', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.4-mini-2026-03-17',
          shortName: 'gpt-5.4-mini',
          deprecated: true,
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(true);
  });

  // #7223 round 3: a "Pro" tier variant (e.g. `gpt-5.5-pro`) reports the same
  // top reasoning-effort tier as its non-Pro sibling, but the Codex backend
  // does not serve Pro models — only the base release is covered by a
  // ChatGPT subscription. This must resolve ineligible despite matching the
  // reasoning-effort-tier heuristic.
  it('rejects the gpt-5.5-pro false positive despite matching the heuristic', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.5-pro-2026-04-23',
          shortName: 'gpt-5.5-pro',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.XHIGH,
          },
        }),
      ),
    ).toBe(false);
  });

  // #7223 round 3: the Pro-tier exclusion is a systematic naming rule, not a
  // per-id table — a future Pro release absent from any hardcoded list must
  // also resolve ineligible, the same way a future top-effort base release
  // (tested above) resolves eligible without a hardcoded edit.
  it('rejects a future Pro-variant id absent from any hardcoded list', () => {
    expect(
      isCodexSubscriptionEligible(
        openAIModel({
          fullName: 'gpt-5.9-pro-2027-01-01',
          shortName: 'gpt-5.9-pro',
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            reasoningEffort: ReasoningEffort.MAX,
          },
        }),
      ),
    ).toBe(false);
  });
});
