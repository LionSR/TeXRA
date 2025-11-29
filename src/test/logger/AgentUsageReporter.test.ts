// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentUsageReporter } from '@/logger/AgentUsageReporter';

describe('AgentUsageReporter', () => {
  it('falls back to passed runId when groupId is not available', () => {
    const streamId = 'stream:test';
    const runId = 'run-123';
    const streamEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });

    let recordedStats: ExtendedTokenUsageStats | undefined;
    const loggerStub = {
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined =>
        undefined,
      statistics: (stats: ExtendedTokenUsageStats) => {
        recordedStats = stats;
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
      reporter.report(stats, runId);

      assert.equal(streamEvents.length, 1);
      // inputTokens is passed through unchanged - cacheCreationInputTokens
      // is tracked separately in the normalized usage system
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
        runId,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.25,
        },
      });
      assert.strictEqual(recordedStats, stats);
    } finally {
      disposeStream();
    }
  });

  it('uses groupId from logger instead of passed runId when available', () => {
    const streamId = 'stream:test';
    const passedRunId = 'execution-id-123';
    const groupId = 'task-group-id-456';
    const streamEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });

    const loggerStub = {
      withCurrentGroup: <T>(fn: (groupId: string) => T): T | undefined =>
        fn(groupId),
      statistics: () => {},
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
    };

    try {
      reporter.report(stats, passedRunId);

      assert.equal(streamEvents.length, 1);
      // groupId should be used instead of passedRunId
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
        runId: groupId, // NOT passedRunId!
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.25,
        },
      });
    } finally {
      disposeStream();
    }
  });

  it('skips statistics logging for tool-use sessions', () => {
    const streamId = 'stream:test';
    const runId = 'run-456';
    const streamEvents: unknown[] = [];
    const disposeStream = bus.on('updateStreamUsage', (payload) => {
      streamEvents.push(payload);
    });

    const loggerStub = {
      withCurrentGroup: <T>(_: (groupId: string) => T): T | undefined =>
        undefined,
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
      reporter.report(stats, runId);

      assert.equal(streamEvents.length, 1);
      assert.deepEqual(streamEvents[0], {
        stream: streamId,
        runId,
        usage: {
          inputTokens: 6,
          outputTokens: 2,
          cost: 0.1,
        },
      });
    } finally {
      disposeStream();
    }
  });
});
