// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - agent runtime
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

// Local imports - schemas
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

// Local imports - tools
import {
  agentCliLoopTerminalStatus,
  markAgentCliLoopError,
} from '@tools/agentCliShared';
import { finalizeCodexLoopStatus } from '@tools/codex';

const streamIds = [
  'stream:codex-loop-running',
  'stream:codex-loop-waiting',
  'stream:codex-loop-stopped',
  'stream:codex-loop-error',
] as const satisfies readonly StreamTabId[];

const runtimeHost = { emit: () => {} } satisfies AgentRuntimeHost;

function effectiveStatus(streamId: StreamTabId): string {
  return StreamStatusService.get(streamId) ?? STREAM_STATUS.READY;
}

describe('finalizeCodexLoopStatus', () => {
  afterEach(() => {
    for (const streamId of streamIds) {
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('clears RUNNING when the Codex loop exits during an interrupted turn', () => {
    const streamId = streamIds[0];
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, { emit: false });

    finalizeCodexLoopStatus(streamId, runtimeHost);

    expect(effectiveStatus(streamId)).toBe(STREAM_STATUS.READY);
  });

  it('clears WAITING when the Codex loop exits between turns', () => {
    const streamId = streamIds[1];
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, { emit: false });

    finalizeCodexLoopStatus(streamId, runtimeHost);

    expect(effectiveStatus(streamId)).toBe(STREAM_STATUS.READY);
  });

  it('preserves terminal statuses set by other runtime paths', () => {
    const streamId = streamIds[2];
    StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, { emit: false });

    finalizeCodexLoopStatus(streamId, runtimeHost);

    expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
  });

  it('preserves error statuses set by failed turns', () => {
    const streamId = streamIds[3];
    StreamStatusService.set(streamId, STREAM_STATUS.ERROR, { emit: false });

    finalizeCodexLoopStatus(streamId, runtimeHost);

    expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.ERROR);
  });

  it('marks loop-owned child streams as errored after a failed turn', () => {
    const streamId = streamIds[0];
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, { emit: false });

    markAgentCliLoopError(streamId, runtimeHost);

    expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.ERROR);
  });

  it('does not overwrite explicit user stops with failed-turn errors', () => {
    const streamId = streamIds[2];
    StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, { emit: false });

    markAgentCliLoopError(streamId, runtimeHost);

    expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
  });

  it('maps loop failure state to persisted terminal status', () => {
    expect(
      agentCliLoopTerminalStatus({
        interrupted: false,
        sawTurnFailure: false,
      }),
    ).toBe('completed');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: true,
        sawTurnFailure: false,
      }),
    ).toBe('interrupted');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: false,
        sawTurnFailure: true,
      }),
    ).toBe('error');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: true,
        sawTurnFailure: true,
      }),
    ).toBe('error');
  });
});
