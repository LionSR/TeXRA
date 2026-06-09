// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  createProgressViewCommandHandlers,
  type ProgressViewCommandActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';

function createActions(): ProgressViewCommandActions & {
  lifecycle: Record<string, ReturnType<typeof vi.fn>>;
  run: Record<string, ReturnType<typeof vi.fn>>;
  file: Record<string, ReturnType<typeof vi.fn>>;
} {
  return {
    lifecycle: {
      setActiveStream: vi.fn(),
      setAgentFilter: vi.fn(),
      deleteStream: vi.fn(),
      deleteAllStreams: vi.fn(),
      stopStream: vi.fn(),
    },
    run: {
      resumeStream: vi.fn(),
      runNewStream: vi.fn(),
    },
    file: {
      openFile: vi.fn(),
      openFileCompile: vi.fn(),
      openTaskStorage: vi.fn(),
      compareOriginal: vi.fn(),
      comparePrevious: vi.fn(),
      acceptFile: vi.fn(),
      mergeFile: vi.fn(),
      latexdiffFile: vi.fn(),
      openLabel: vi.fn(),
    },
    followUp: {
      sendFollowUp: vi.fn(),
      reportImageSaveError: vi.fn(),
    },
    bypass: {
      runtimeHost: { emit: vi.fn() } satisfies AgentRuntimeHost,
    },
    approval: {
      handleToolEditApprovalAction: vi.fn().mockReturnValue(true),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    },
  };
}

describe('createProgressViewCommandHandlers', () => {
  it('routes lifecycle commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

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

    expect(actions.lifecycle.setActiveStream).toHaveBeenCalledWith('stream-a');
    expect(actions.lifecycle.setAgentFilter).toHaveBeenCalledWith('all');
    expect(actions.lifecycle.deleteStream).toHaveBeenCalledWith('stream-b');
    expect(actions.lifecycle.deleteAllStreams).toHaveBeenCalledWith();
    expect(actions.lifecycle.stopStream).toHaveBeenCalledWith('stream-c');
  });

  it('routes run-control commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

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

    expect(actions.run.resumeStream).toHaveBeenCalledWith('stream-a');
    expect(actions.run.runNewStream).toHaveBeenCalledWith('stream-b');
  });

  it('routes file commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

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

    expect(actions.file.openFile).toHaveBeenCalledWith('paper.tex', 12);
    expect(actions.file.openFileCompile).toHaveBeenCalledWith('paper.tex');
    expect(actions.file.openTaskStorage).toHaveBeenCalledWith('stream-a');
    expect(actions.file.compareOriginal).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.file.comparePrevious).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
      'previous.tex',
    );
    expect(actions.file.acceptFile).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.file.mergeFile).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.file.latexdiffFile).toHaveBeenCalledWith(
      'edited.tex',
      'paper.tex',
    );
    expect(actions.file.openLabel).toHaveBeenCalledWith('thm:main');
  });
});
