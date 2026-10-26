// Claude Agent SDK boundary: the run's usage and cost are folded from the
// SDK's authoritative per-model usage, nested model calls included.

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { claudeResultUsage } from '@texra/tools/claudeAgentShared';

describe('Claude Agent SDK adapter', () => {
  it('folds authoritative modelUsage across main and nested model calls', () => {
    const usage = claudeResultUsage({
      modelUsage: {
        main: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
        subagent: {
          inputTokens: 70,
          outputTokens: 30,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 2,
          webSearchRequests: 1,
          costUSD: 0.02,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    } as never);

    expect(usage).toEqual({
      inputTokens: 170,
      outputTokens: 50,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 7,
      cost: 0.03,
    });
  });
});
