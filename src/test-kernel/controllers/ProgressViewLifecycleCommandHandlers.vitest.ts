// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewLifecycleCommandHandlers } from '@controllers/progressView/ProgressViewLifecycleCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';

describe('createProgressViewLifecycleCommandHandlers', () => {
  it('routes progress lifecycle commands to host actions', () => {
    const actions = {
      setActiveStream: vi.fn(),
      setAgentFilter: vi.fn(),
      deleteStream: vi.fn(),
      deleteAllStreams: vi.fn(),
      stopStream: vi.fn(),
    };
    const handlers = createProgressViewLifecycleCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, stream: 'stream-a' },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, filter: 'all' },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM, stream: 'stream-b' },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.STOP_STREAM, stream: 'stream-c' },
        handlers,
      ),
    ).toBe(true);

    expect(actions.setActiveStream).toHaveBeenCalledWith('stream-a');
    expect(actions.setAgentFilter).toHaveBeenCalledWith('all');
    expect(actions.deleteStream).toHaveBeenCalledWith('stream-b');
    expect(actions.deleteAllStreams).toHaveBeenCalledWith();
    expect(actions.stopStream).toHaveBeenCalledWith('stream-c');
    expect(handlers[PROGRESS_VIEW_COMMANDS.RESUME]).toBeUndefined();
  });
});
