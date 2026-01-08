// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentUsageReporter } from '@/logger/AgentUsageReporter';

describe('AgentUsageReporter', () => {
  /**
   * AgentUsageReporter trusts the passed storageKey as the single source of truth.
   * It does NOT query the logger for group IDs - no round-trips.
   */
  it('trusts storageKey as single source of truth (no round-trip to logger)', () => {
    const streamId = 'stream:test';
    const storageKey = 'task-group-123' as StorageKey;
    const streamEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });

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
    } as unknown as AgentLogger;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.Workflow,
    );
    const stats: ExtendedTokenUsageStats = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.25,
      cacheCreationInputTokens: 4,
    };

    try {
      reporter.report(stats, storageKey);

      assert.equal(streamEvents.length, 1);
      // storageKey is THE single source of truth - no runId needed
      // Cache tokens are passed through for display
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
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
    } finally {
      disposeStream();
    }
  });

  it('skips statistics logging for tool-use sessions', () => {
    const streamId = 'stream:test';
    const storageKey = 'execution-id-456' as StorageKey;
    const streamEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });

    const loggerStub = {
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined => {
        throw new Error('withCurrentGroup should not be called');
      },
      statistics: () => {
        throw new Error('statistics should not be called for tool-use runs');
      },
    } as unknown as AgentLogger;

    const reporter = new AgentUsageReporter(
      loggerStub,
      streamId,
      AgentCategory.ToolUse,
    );

    const stats: ExtendedTokenUsageStats = {
      inputTokens: 6,
      outputTokens: 2,
      cost: 0.1,
      cacheCreationInputTokens: 1,
    };

    try {
      reporter.report(stats, storageKey);

      assert.equal(streamEvents.length, 1);
      // Cache tokens are passed through for display
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
        storageKey,
        usage: {
          inputTokens: 6,
          outputTokens: 2,
          cost: 0.1,
          cacheCreationInputTokens: 1,
        },
      });
    } finally {
      disposeStream();
    }
  });
});
