// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewBypassCommandHandlers } from '@controllers/progressView/ProgressViewBypassCommandHandlers';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';
import {
  cleanupAllApprovals,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  isProposalBypassedForStream,
} from '@tools/approval';

function createRecordingRuntimeHost(): {
  events: Array<{ event: string; payload: unknown }>;
  host: AgentRuntimeHost;
} {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    host: {
      emit: (event, payload) => {
        events.push({ event, payload });
      },
    },
  };
}

describe('createProgressViewBypassCommandHandlers', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('keeps tool-edit and bash bypass symmetric behind the edit shield', async () => {
    const stream = 'stream:edit-bypass';
    const { events, host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const handlers = createProgressViewBypassCommandHandlers({
      runtimeHost: host,
      showInfo,
    });

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
          stream,
        },
        handlers,
      ),
    ).toBe(true);
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(true);
    expect(events).toEqual([
      {
        event: 'updateToolEditApprovalBypassState',
        payload: { streamId: stream, bypassActive: true },
      },
    ]);
    expect(showInfo).toHaveBeenCalledWith(
      'YOLO mode enabled: Tool actions and bash commands will be auto-approved for this stream.',
    );

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
          stream,
        },
        handlers,
      ),
    ).toBe(true);
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(false);
    expect(isBashApprovalBypassedForStream(stream)).toBe(false);
    expect(events.at(-1)).toEqual({
      event: 'updateToolEditApprovalBypassState',
      payload: { streamId: stream, bypassActive: false },
    });
  });

  it('makes delegated task bypass enable edit and bash bypasses', async () => {
    const stream = 'stream:proposal-bypass';
    const { events, host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const handlers = createProgressViewBypassCommandHandlers({
      runtimeHost: host,
      showInfo,
    });

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
          stream,
        },
        handlers,
      ),
    ).toBe(true);
    await Promise.resolve();

    expect(isProposalBypassedForStream(stream)).toBe(true);
    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(true);
    expect(events).toEqual([
      {
        event: 'updateSuperYoloBypassState',
        payload: { streamId: stream, bypassActive: true },
      },
      {
        event: 'updateToolEditApprovalBypassState',
        payload: { streamId: stream, bypassActive: true },
      },
    ]);
    expect(showInfo).toHaveBeenCalledWith(
      'Delegated task auto-approval enabled for this stream.',
    );

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
          stream,
        },
        handlers,
      ),
    ).toBe(true);
    await Promise.resolve();

    expect(isProposalBypassedForStream(stream)).toBe(false);
    expect(isApprovalBypassedForStream(stream)).toBe(false);
    expect(isBashApprovalBypassedForStream(stream)).toBe(false);
    expect(events.slice(-2)).toEqual([
      {
        event: 'updateSuperYoloBypassState',
        payload: { streamId: stream, bypassActive: false },
      },
      {
        event: 'updateToolEditApprovalBypassState',
        payload: { streamId: stream, bypassActive: false },
      },
    ]);
  });
});
