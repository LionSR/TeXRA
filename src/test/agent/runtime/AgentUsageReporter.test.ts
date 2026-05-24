// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { AgentUsageReporter } from '@agent/runtime/AgentUsageReporter';
import type { ExtendedTokenUsageStats, StorageKey } from '@shared/schemas';

function createUsageHost(): { events: unknown[]; host: AgentRuntimeHost } {
  const events: unknown[] = [];
  return {
    events,
    host: {
      emit: (event, payload) => {
        if (event === 'updateStreamUsage') {
          events.push(payload);
        }
      },
    },
  };
}

describe('AgentUsageReporter', () => {
  /**
   * AgentUsageReporter trusts the passed storageKey as the single source of truth.
   * It does NOT query the logger for group IDs - no round-trips.
   */
  it('trusts storageKey as single source of truth (no round-trip to logger)', () => {
    const streamId = 'stream:test';
    const storageKey = 'task-group-123' as StorageKey;
    const { events, host } = createUsageHost();

    let recordedStats: ExtendedTokenUsageStats | undefined;
    let recordedStorageKey: string | undefined;
    const loggerStub = {
      // This should NOT be called - we don't do round-trips anymore
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined => {
        throw new Error(
          'withCurrentGroup should not be called - no round-trips!',
        );
      },
      statistics: (stats: ExtendedTokenUsageStats, key: string) => {
        recordedStats = stats;
        recordedStorageKey = key;
      },
    } as unknown as AgentTrace;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.Workflow,
      host,
    );
    const stats: ExtendedTokenUsageStats = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.25,
      cacheCreationInputTokens: 4,
    };

    reporter.report(stats, storageKey);

    assert.equal(events.length, 1);
    // storageKey is THE single source of truth - no runId needed
    // Cache tokens are passed through for display
    assert.deepEqual(events[0], {
      streamId,
      storageKey,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.25,
        cacheCreationInputTokens: 4,
      },
    });
    // Verify statistics were logged with storageKey
    assert.strictEqual(recordedStats, stats);
    assert.strictEqual(recordedStorageKey, storageKey);
  });

  it('skips statistics logging for tool-use sessions', () => {
    const streamId = 'stream:test';
    const storageKey = 'execution-id-456' as StorageKey;
    const { events, host } = createUsageHost();

    const loggerStub = {
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined => {
        throw new Error('withCurrentGroup should not be called');
      },
      statistics: () => {
        throw new Error('statistics should not be called for tool-use runs');
      },
    } as unknown as AgentTrace;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.ToolUse,
      host,
    );

    const stats: ExtendedTokenUsageStats = {
      inputTokens: 6,
      outputTokens: 2,
      cost: 0.1,
      cacheCreationInputTokens: 1,
    };

    reporter.report(stats, storageKey);

    assert.equal(events.length, 1);
    // Cache tokens are passed through for display
    assert.deepEqual(events[0], {
      streamId,
      storageKey,
      usage: {
        inputTokens: 6,
        outputTokens: 2,
        cost: 0.1,
        cacheCreationInputTokens: 1,
      },
    });
  });

  it('passes through both cacheRead and cacheCreation tokens', () => {
    const streamId = 'stream:test';
    const storageKey = 'task-group-789' as StorageKey;
    const { events, host } = createUsageHost();

    const loggerStub = {
      statistics: () => {
        /* no-op */
      },
    } as unknown as AgentTrace;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.Workflow,
      host,
    );

    const stats: ExtendedTokenUsageStats = {
      inputTokens: 100,
      outputTokens: 50,
      cost: 1.5,
      cacheReadInputTokens: 80, // Cache hits (discounted)
      cacheMissInputTokens: 20, // Cache misses (full price)
      cacheCreationInputTokens: 20, // Cache writes (1.25x for Anthropic)
    };

    reporter.report(stats, storageKey);

    assert.equal(events.length, 1);
    // Both cache token types should be passed through
    assert.deepEqual(events[0], {
      streamId,
      storageKey,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cost: 1.5,
        cacheReadInputTokens: 80,
        cacheMissInputTokens: 20,
        cacheCreationInputTokens: 20,
      },
    });
  });

  it('omits cache tokens when zero or undefined', () => {
    const streamId = 'stream:test';
    const storageKey = 'task-group-000' as StorageKey;
    const { events, host } = createUsageHost();

    const loggerStub = {
      statistics: () => {
        /* no-op */
      },
    } as unknown as AgentTrace;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.Workflow,
      host,
    );

    // No cache tokens in stats
    const stats: ExtendedTokenUsageStats = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.1,
    };

    reporter.report(stats, storageKey);

    assert.equal(events.length, 1);
    // Cache tokens should be omitted when not present
    assert.deepEqual(events[0], {
      streamId,
      storageKey,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.1,
      },
    });
  });

  it('uses the runtime host passed by the owner', () => {
    const streamId = 'stream:test';
    const storageKey = 'task-group-scoped' as StorageKey;
    const { events, host } = createUsageHost();

    const loggerStub = {
      statistics: () => {
        /* no-op */
      },
    } as unknown as AgentTrace;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.Workflow,
      host,
    );
    reporter.report(
      {
        inputTokens: 1,
        outputTokens: 2,
        cost: 0.03,
      },
      storageKey,
    );

    assert.deepEqual(events, [
      {
        streamId,
        storageKey,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cost: 0.03,
        },
      },
    ]);
  });
});
