// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports
import {
  AgentCategory,
  STREAM_STATUS,
  type RestoredStreamSnapshot,
  type StreamTabInfo,
} from '@shared/schemas';
import { buildRestoredStreamSnapshot } from '@shared/progressView/backend/streamInfoUtils';
import { compareByNewestCreationTime } from '@shared/progressView/backend/streamOrdering';

function streamInfo(name: string, creationTimestamp: number): StreamTabInfo {
  return {
    name,
    label: name,
    agentCategory: 'workflow',
    creationTimestamp,
  };
}

function restoredSnapshot(
  overrides: Partial<RestoredStreamSnapshot>,
): RestoredStreamSnapshot {
  return {
    streamId: 'restored-stream',
    label: 'Restored label',
    agent: 'restored-agent',
    agentCategory: AgentCategory.ToolUse,
    inputFile: 'restored.tex',
    instruction: 'Restored instruction',
    lastKnownStatus: STREAM_STATUS.WAITING,
    description: 'Restored description',
    executionId: 'restored-exec',
    parentStreamId: 'restored-parent',
    creationTimestamp: 100,
    lastTimestamp: 150,
    persistedAt: 175,
    ...overrides,
  };
}

function progressState(overrides: {
  taskState?: unknown;
  hints?: Record<string, unknown>;
  firstTimestamp?: number;
  lastTimestamp?: number;
  executionId?: string;
  parentStreamId?: string;
  description?: string;
}): any {
  return {
    streamLogs: {
      keys: () => [].values(),
      getFirstTimestamp: () => overrides.firstTimestamp,
      getLastTimestamp: () => overrides.lastTimestamp,
    },
    snapshots: {
      getTaskState: () => overrides.taskState,
      getExecutionId: () => overrides.executionId,
      getParentStreamId: () => overrides.parentStreamId,
      getDescription: () => overrides.description,
    },
    getStreamHints: () => overrides.hints ?? {},
  };
}

describe('compareByNewestCreationTime', () => {
  it('orders streams newest first by creation time', () => {
    const streams = [streamInfo('older', 100), streamInfo('newer', 200)].sort(
      compareByNewestCreationTime,
    );

    assert.deepEqual(
      streams.map((stream) => stream.name),
      ['newer', 'older'],
    );
  });

  it('uses stream name as a stable tie-breaker', () => {
    const streams = [
      streamInfo('b-stream', 100),
      streamInfo('a-stream', 100),
    ].sort(compareByNewestCreationTime);

    assert.deepEqual(
      streams.map((stream) => stream.name),
      ['a-stream', 'b-stream'],
    );
  });
});

describe('buildRestoredStreamSnapshot', () => {
  it('prefers live stream metadata and supplied runtime status', () => {
    const state = progressState({
      taskState: {
        agentConfig: {
          agent: 'writer',
          agentCategory: AgentCategory.Workflow,
          inputFiles: ['/work/paper.tex'],
          instruction: 'Improve the proof.',
        },
      },
      firstTimestamp: 10,
      lastTimestamp: 20,
      executionId: 'live-exec',
      parentStreamId: 'live-parent',
      description: 'Live description',
    });

    const snapshot = buildRestoredStreamSnapshot(state, 'writer@1', {
      restored: restoredSnapshot({ streamId: 'writer@1' }),
      lastKnownStatus: STREAM_STATUS.RUNNING,
      now: () => 30,
    });

    assert.deepEqual(snapshot, {
      streamId: 'writer@1',
      label: 'writer: paper.tex',
      agent: 'writer',
      agentCategory: AgentCategory.Workflow,
      inputFile: '/work/paper.tex',
      instruction: 'Improve the proof.',
      lastKnownStatus: STREAM_STATUS.RUNNING,
      description: 'Live description',
      executionId: 'live-exec',
      parentStreamId: 'live-parent',
      creationTimestamp: 10,
      lastTimestamp: 20,
      persistedAt: 30,
    });
  });

  it('uses restored values for holes in the live projection', () => {
    const state = progressState({
      hints: {
        agent: 'ghost',
        agentCategory: AgentCategory.Workflow,
      },
      firstTimestamp: 10,
    });

    const snapshot = buildRestoredStreamSnapshot(state, 'ghost@1', {
      restored: restoredSnapshot({ streamId: 'ghost@1' }),
      now: () => 30,
    });

    assert.equal(snapshot.label, 'ghost');
    assert.equal(snapshot.agent, 'ghost');
    assert.equal(snapshot.agentCategory, AgentCategory.Workflow);
    assert.equal(snapshot.inputFile, 'restored.tex');
    assert.equal(snapshot.instruction, 'Restored instruction');
    assert.equal(snapshot.lastKnownStatus, STREAM_STATUS.WAITING);
    assert.equal(snapshot.description, 'Restored description');
    assert.equal(snapshot.executionId, 'restored-exec');
    assert.equal(snapshot.parentStreamId, 'restored-parent');
    assert.equal(snapshot.creationTimestamp, 10);
    assert.equal(snapshot.lastTimestamp, 150);
    assert.equal(snapshot.persistedAt, 30);
  });

  it('defaults unknown status to stopped', () => {
    const state = progressState({
      hints: { agent: 'bare' },
      firstTimestamp: 10,
    });

    const snapshot = buildRestoredStreamSnapshot(state, 'bare@1', {
      now: () => 30,
    });

    assert.equal(snapshot.lastKnownStatus, STREAM_STATUS.STOPPED);
  });
});
