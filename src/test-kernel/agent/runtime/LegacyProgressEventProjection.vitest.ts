// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { attachLegacyProgressEventProjection } from '@agent/runtime/LegacyProgressEventProjection';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type {
  ActiveChildInfo,
  ExecutionId,
  StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('LegacyProgressEventProjection', () => {
  it('maps Stage 3a session and child/process facts onto legacy progress events', () => {
    const hub = new SessionEventHub();
    const host = createRecordingHost();
    const parentStreamId = 'stream:parent' as StreamTabId;
    const childStreamId = 'stream:child' as StreamTabId;
    const executionId = 'exec:process-output' as ExecutionId;
    const child: ActiveChildInfo = {
      kind: 'subagent',
      executionId: 'exec:child' as ExecutionId,
      childStreamId,
      agentName: 'orchestrator',
      status: 'running',
      startedAt: 1,
      elapsed: null,
    };
    const process: ActiveChildInfo = {
      kind: 'process',
      executionId,
      agentName: 'bash',
      status: 'running',
      startedAt: 2,
      elapsed: '1s',
      toolName: 'bash',
    };

    const detach = attachLegacyProgressEventProjection(hub, host.host);
    try {
      hub.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId: parentStreamId },
        },
      });
      hub.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'child.activity',
          kind: 'subagents',
          parentStreamId,
          children: [child],
        },
      });
      hub.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId,
          processes: [process],
        },
      });
      hub.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'child.activity',
          kind: 'parent',
          childStreamId,
          parentStreamId,
        },
      });
      hub.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'process.output',
          parentStreamId,
          executionId,
          stdout: 'hello',
          stderr: '',
        },
      });

      expect(host.events).toEqual([
        {
          event: 'updateQueuedFollowUps',
          payload: { streamId: parentStreamId },
        },
        {
          event: 'updateActiveSubagents',
          payload: { parentStreamId, children: [child] },
        },
        {
          event: 'updateActiveProcesses',
          payload: { parentStreamId, processes: [process] },
        },
        {
          event: 'setParentStream',
          payload: { childStreamId, parentStreamId },
        },
        {
          event: 'updateProcessOutput',
          payload: { parentStreamId, executionId, stdout: 'hello', stderr: '' },
        },
      ]);
    } finally {
      detach();
    }
  });

  it('projects typed round stages onto the host round-stage payload', () => {
    const hub = new SessionEventHub();
    const host = createRecordingHost();
    const streamId = 'stream:round' as StreamTabId;

    const detach = attachLegacyProgressEventProjection(hub, host.host);
    try {
      hub.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'stage.start',
          id: 'r1',
          label: 'r1',
          kind: 'round',
          index: 1,
          total: 3,
        },
      });
      hub.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'stage.start',
          id: 'r2',
          label: 'r2',
          kind: 'round',
          index: 2,
          total: 0,
        },
      });
      hub.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'stage.start',
          id: 'init',
          label: 'Init',
          kind: 'phase',
        },
      });

      expect(host.events).toEqual([
        {
          event: 'updateRoundStage',
          payload: { streamId, roundStage: { index: 1, total: 3 } },
        },
        {
          event: 'updateRoundStage',
          payload: { streamId, roundStage: { index: 2 } },
        },
      ]);
    } finally {
      detach();
    }
  });
});
