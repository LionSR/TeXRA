import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';

/** A minimal OpenAI `ModelConfig` fixture, overridable per test. */
function openAIModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    ref: 'openai/gpt-test',
    label: 'Test Model',
    id: 'gpt-test',
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
        id: 'gpt-5.6-sol',
        shortName: 'gpt-5.6',
        codexSubscription: true,
        reasoning: {
          efforts: [ReasoningEffort.MEDIUM],
          providerDefault: ReasoningEffort.MEDIUM,
        },
      },
      eligible: true,
    },
    {
      // Top reasoning tier + `codex` name + live: everything the old heuristic
      // trusted. Absent the registry flag, it must not route to Codex.
      name: 'rejects an unflagged model even when every old-heuristic proxy matches',
      overrides: {
        id: 'gpt-5.9-codex',
        shortName: 'gpt-5.9-codex',
        reasoning: {
          efforts: [ReasoningEffort.MAX],
          providerDefault: ReasoningEffort.MAX,
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
        id: 'claude-codex-lookalike',
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

  it('sends a pro-mode request to the API key: the Codex backend serves no pro mode', () => {
    const model = openAIModel({ codexSubscription: true, modes: ['pro'] });
    const facts = { ...OWN_KEY_ROUTE_FACTS, chatgptSubscription: true };
    expect(decideModelRoute(model, facts).kind).toBe('chatgpt-subscription');
    expect(decideModelRoute(model, { ...facts, mode: 'pro' }).kind).not.toBe(
      'chatgpt-subscription',
    );
  });

  it('keeps a Responses-only model on the subscription under the OpenRouter toggle', () => {
    const facts = {
      ...OWN_KEY_ROUTE_FACTS,
      chatgptSubscription: true,
      useOpenRouter: true,
    };
    const flagged = { codexSubscription: true };
    // No OpenRouter route exists for it, so the toggle cannot move it.
    expect(
      decideModelRoute(
        openAIModel({ ...flagged, requiresResponsesAPI: true }),
        facts,
      ).kind,
    ).toBe('chatgpt-subscription');
    expect(decideModelRoute(openAIModel(flagged), facts).kind).toBe(
      'openrouter',
    );
  });
});
