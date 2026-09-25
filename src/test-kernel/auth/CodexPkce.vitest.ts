import { createHash } from 'node:crypto';

import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { computeCodeChallenge } from '@auth/oauth/pkce';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';

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
  it('derives the challenge as base64url(SHA-256(verifier))', () => {
    const verifier = 'fixed-test-verifier-value';
    const expected = createHash('sha256').update(verifier).digest('base64url');
    const challenge = computeCodeChallenge(verifier);
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(BASE64URL);
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
  it.each<{
    name: string;
    overrides: Partial<ModelConfig>;
    eligible: boolean;
  }>([
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
  ])('$name', ({ overrides, eligible }) => {
    expect(
      decideModelRoute(openAIModel(overrides), {
        ...OWN_KEY_ROUTE_FACTS,
        chatgptSubscription: true,
      }).kind === 'chatgpt-subscription',
    ).toBe(eligible);
  });
});
