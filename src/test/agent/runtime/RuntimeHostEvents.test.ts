// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { STREAM_STATUS } from '@shared/schemas';

type RecordedEvent = {
  event: keyof ProgressEventPayloads;
  payload: ProgressEventPayloads[keyof ProgressEventPayloads];
};

function createRecordingHost(): {
  events: RecordedEvent[];
  host: AgentRuntimeHost;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    host: createAgentRuntimeHost({
      emit: (event, payload) => events.push({ event, payload }),
    }),
  };
}

describe('agent runtime host events', () => {
  it('routes runtime event helpers through the progress sink', () => {
    const { events, host } = createRecordingHost();

    host.updateQueuedFollowUps({ streamId: 'stream:queued' });
    host.setParentStream({
      childStreamId: 'stream:child',
      parentStreamId: 'stream:parent',
    });
    host.updateActiveSubagents({
      parentStreamId: 'stream:parent',
      children: [],
    });
    host.updateActiveProcesses({
      parentStreamId: 'stream:parent',
      processes: [],
    });
    host.updateProcessOutput({
      parentStreamId: 'stream:parent',
      executionId: 'execution:process',
      stdout: 'out',
      stderr: 'err',
    });

    assert.deepEqual(events, [
      {
        event: 'updateQueuedFollowUps',
        payload: { streamId: 'stream:queued' },
      },
      {
        event: 'setParentStream',
        payload: {
          childStreamId: 'stream:child',
          parentStreamId: 'stream:parent',
        },
      },
      {
        event: 'updateActiveSubagents',
        payload: { parentStreamId: 'stream:parent', children: [] },
      },
      {
        event: 'updateActiveProcesses',
        payload: { parentStreamId: 'stream:parent', processes: [] },
      },
      {
        event: 'updateProcessOutput',
        payload: {
          parentStreamId: 'stream:parent',
          executionId: 'execution:process',
          stdout: 'out',
          stderr: 'err',
        },
      },
    ]);
  });

  it('lets StreamStatusService emit through a scoped runtime host', () => {
    const { events, host } = createRecordingHost();

    StreamStatusService.set('stream:status', STREAM_STATUS.RUNNING, {
      runtimeHost: host,
    });
    StreamStatusService.clear('stream:status', {
      emit: false,
      runtimeHost: host,
    });

    assert.deepEqual(events, [
      {
        event: 'updateStreamStatus',
        payload: {
          streamId: 'stream:status',
          status: STREAM_STATUS.RUNNING,
          previousStatus: STREAM_STATUS.READY,
        },
      },
    ]);
  });
});
