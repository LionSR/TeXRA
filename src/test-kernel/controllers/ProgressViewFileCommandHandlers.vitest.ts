// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewFileCommandHandlers } from '@controllers/progressView/ProgressViewFileCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';

describe('createProgressViewFileCommandHandlers', () => {
  it('routes progress file commands to host actions', () => {
    const actions = {
      openFile: vi.fn(),
      openFileCompile: vi.fn(),
      openTaskStorage: vi.fn(),
      compareOriginal: vi.fn(),
      comparePrevious: vi.fn(),
      acceptFile: vi.fn(),
      mergeFile: vi.fn(),
      latexdiffFile: vi.fn(),
      openLabel: vi.fn(),
    };
    const handlers = createProgressViewFileCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
          file: 'paper.tex',
          line: 12,
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE,
          file: 'paper.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE,
          stream: 'stream-a',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL,
          file: 'edited.tex',
          base: 'paper.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
          file: 'edited.tex',
          base: 'paper.tex',
          prev: 'previous.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.ACCEPT_FILE,
          file: 'edited.tex',
          base: 'paper.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.MERGE_FILE,
          file: 'edited.tex',
          base: 'paper.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE,
          file: 'edited.tex',
          base: 'paper.tex',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.OPEN_LABEL, label: 'thm:main' },
        handlers,
      ),
    ).toBe(true);

    expect(actions.openFile).toHaveBeenCalledWith('paper.tex', 12);
    expect(actions.openFileCompile).toHaveBeenCalledWith('paper.tex');
    expect(actions.openTaskStorage).toHaveBeenCalledWith('stream-a');
    expect(actions.compareOriginal).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.comparePrevious).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
      'previous.tex',
    );
    expect(actions.acceptFile).toHaveBeenCalledWith('edited.tex', 'paper.tex');
    expect(actions.mergeFile).toHaveBeenCalledWith('edited.tex', 'paper.tex');
    expect(actions.latexdiffFile).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.openLabel).toHaveBeenCalledWith('thm:main');
    expect(handlers[PROGRESS_VIEW_COMMANDS.RESUME]).toBeUndefined();
  });
});
