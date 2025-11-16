// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentUsageReporter } from '@/logger/AgentUsageReporter';

describe('AgentUsageReporter', () => {
  it('emits updateStreamUsage when no group is active', () => {
    const streamId = 'stream:test';
    const runId = 'run-123';
    const streamEvents: unknown[] = [];
    const groupEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });
    const disposeGroup = bus.on('updateGroupUsage', (payload) => {
      groupEvents.push(payload);
    });

    let recordedStats: ExtendedTokenUsageStats | undefined;
    const loggerStub = {
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined =>
        undefined,
      statistics: (stats: ExtendedTokenUsageStats) => {
        recordedStats = stats;
      },
    } as unknown as AgentLogger;

    const reporter = new AgentUsageReporter(loggerStub, streamId);
    const stats: ExtendedTokenUsageStats = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.25,
      cacheCreationInputTokens: 4,
    };

    try {
      reporter.report(stats, runId);

      assert.equal(groupEvents.length, 0);
      assert.equal(streamEvents.length, 1);
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
        runId,
        usage: {
          inputTokens: 14,
          outputTokens: 5,
          cost: 0.25,
        },
      });
      assert.strictEqual(recordedStats, stats);
    } finally {
      disposeStream();
      disposeGroup();
    }
  });
});
