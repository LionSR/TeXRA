// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewRunCommandHandlers } from '@controllers/progressView/ProgressViewRunCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';

describe('createProgressViewRunCommandHandlers', () => {
  it('routes run-control commands to host actions', () => {
    const actions = {
      resumeStream: vi.fn(),
      runNewStream: vi.fn(),
    };
    const handlers = createProgressViewRunCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.RESUME, stream: 'stream-a' },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.RUN_NEW, stream: 'stream-b' },
        handlers,
      ),
    ).toBe(true);

    expect(actions.resumeStream).toHaveBeenCalledWith('stream-a');
    expect(actions.runNewStream).toHaveBeenCalledWith('stream-b');
    expect(handlers[PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]).toBeUndefined();
  });
});
