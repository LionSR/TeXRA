// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import { cleanupAllApprovals } from '@tools/approval';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopProgressIpcModule {
  createDesktopProgressIpc(options: {
    progress: {
      syncFullView(): void;
      setActiveStream(stream: string): void;
      setAgentFilter(filter: string): void;
      deleteStream(stream: string): Promise<void>;
      deleteAllStreams(): Promise<void>;
      stopStream(stream: string): void;
      resumeStream(stream: string): Promise<void>;
      runNewStream(stream: string): Promise<void>;
      sendFollowUp(
        stream: string,
        text: string,
        mediaFiles?: readonly string[],
      ): Promise<void>;
      openFile(file: string, line?: number): Promise<void>;
      openFileCompile(file: string): Promise<void>;
      openTaskStorage(stream: string): Promise<void>;
      compareOriginal(file: string, base?: string): Promise<void>;
      comparePrevious(
        file: string,
        base?: string,
        previous?: string,
      ): Promise<void>;
      acceptFile(file: string, base?: string): Promise<void>;
      mergeFile(file: string, base?: string): Promise<void>;
      latexdiffFile(file: string, base?: string): Promise<void>;
      openLabel(label: string): Promise<void>;
      handleToolEditApprovalAction(message: {
        command: string;
        requestId: string;
        action: string;
        feedback?: string;
      }): boolean;
      handleBashApprovalAction(message: {
        command: string;
        requestId: string;
        action: string;
        feedback?: string;
      }): Promise<void>;
      handlePlanApprovalAction(message: {
        command: string;
        approvalId: string;
        action: string;
        feedback?: string;
      }): void;
      handleUserQuestionAction(message: {
        command: string;
        questionId: string;
        action: string;
        answer?: string;
      }): Promise<void>;
      handleAgentProposalAction(message: {
        command: string;
        proposalId: string;
        action: string;
        feedback?: string;
        model?: string;
        agent?: string;
      }): Promise<boolean>;
      runtimeHost: AgentRuntimeHost;
    };
    onUnsupportedCommand?: (message: { command: string }) => void;
    onAsyncError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean | Promise<boolean>;
  };
}

async function loadDesktopProgressIpc(): Promise<DesktopProgressIpcModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressIpc.ts'))
  ) as Promise<DesktopProgressIpcModule>;
}

function createProgress() {
  return {
    syncFullView: vi.fn(),
    setActiveStream: vi.fn(),
    setAgentFilter: vi.fn(),
    deleteStream: vi.fn(async (_stream: string) => {}),
    deleteAllStreams: vi.fn(async () => {}),
    stopStream: vi.fn(),
    resumeStream: vi.fn(async (_stream: string) => {}),
    runNewStream: vi.fn(async (_stream: string) => {}),
    sendFollowUp: vi.fn(
      async (
        _stream: string,
        _text: string,
        _mediaFiles?: readonly string[],
      ) => {},
    ),
    openFile: vi.fn(async (_file: string, _line?: number) => {}),
    openFileCompile: vi.fn(async (_file: string) => {}),
    openTaskStorage: vi.fn(async (_stream: string) => {}),
    compareOriginal: vi.fn(async (_file: string, _base?: string) => {}),
    comparePrevious: vi.fn(
      async (_file: string, _base?: string, _previous?: string) => {},
    ),
    acceptFile: vi.fn(async (_file: string, _base?: string) => {}),
    mergeFile: vi.fn(async (_file: string, _base?: string) => {}),
    latexdiffFile: vi.fn(async (_file: string, _base?: string) => {}),
    openLabel: vi.fn(async (_label: string) => {}),
    handleToolEditApprovalAction: vi.fn(() => true),
    handleBashApprovalAction: vi.fn(async () => {}),
    handlePlanApprovalAction: vi.fn(),
    handleUserQuestionAction: vi.fn(async () => {}),
    handleAgentProposalAction: vi.fn(async () => true),
    runtimeHost: {
      emit: vi.fn(),
    },
  };
}

describe('desktop Progress IPC', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('syncs Progress state on readiness while allowing shared view-state handling', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({ command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(false);
    expect(progress.syncFullView).toHaveBeenCalledTimes(1);
  });

  it('handles basic Progress stream commands through the shared bridge', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(progress.setActiveStream).toHaveBeenCalledWith('run-1');

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS,
        filter: 'workflow',
      }),
    ).toBe(true);
    expect(progress.setAgentFilter).toHaveBeenCalledWith('workflow');

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.deleteStream).toHaveBeenCalledWith('run-1');

    expect(
      ipc.handleMessage({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.deleteAllStreams).toHaveBeenCalledTimes(1);
  });

  it('opens Progress file actions through the desktop preview host', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/tmp/output.pdf',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.openFile).toHaveBeenCalledWith(
      '/tmp/output.pdf',
      undefined,
    );

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE,
        file: '/tmp/output.tex',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.openFileCompile).toHaveBeenCalledWith('/tmp/output.tex');
  });

  it('maps workflow file operations to the desktop bridge', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL,
        file: '/tmp/r1.tex',
        base: '/tmp/base.tex',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
        file: '/tmp/r2.tex',
        base: '/tmp/base.tex',
        prev: '/tmp/r1.tex',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.ACCEPT_FILE,
        file: '/tmp/r1.tex',
        base: '/tmp/base.tex',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.MERGE_FILE,
        file: '/tmp/r1.tex',
        base: '/tmp/base.tex',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE,
        file: '/tmp/r1.tex',
        base: '/tmp/base.tex',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_LABEL,
        label: 'eq:main',
      }),
    ).toBe(true);

    await Promise.resolve();
    expect(progress.openTaskStorage).toHaveBeenCalledWith('run-1');
    expect(progress.compareOriginal).toHaveBeenCalledWith(
      '/tmp/r1.tex',
      '/tmp/base.tex',
    );
    expect(progress.comparePrevious).toHaveBeenCalledWith(
      '/tmp/r2.tex',
      '/tmp/base.tex',
      '/tmp/r1.tex',
    );
    expect(progress.acceptFile).toHaveBeenCalledWith(
      '/tmp/r1.tex',
      '/tmp/base.tex',
    );
    expect(progress.mergeFile).toHaveBeenCalledWith(
      '/tmp/r1.tex',
      '/tmp/base.tex',
    );
    expect(progress.latexdiffFile).toHaveBeenCalledWith(
      '/tmp/r1.tex',
      '/tmp/base.tex',
    );
    expect(progress.openLabel).toHaveBeenCalledWith('eq:main');
  });

  it('routes unsupported Progress commands through an explicit handler', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(progress.stopStream).toHaveBeenCalledWith('run-1');
    expect(onUnsupportedCommand).not.toHaveBeenCalled();

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
        view: 'progress',
      }),
    ).toBe(false);
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
  });

  it('maps high-use Progress action commands to the desktop bridge', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.RESUME,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'run-1',
        text: 'continue please',
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/tmp/out.tex',
        line: 4,
      }),
    ).toBe(true);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE,
        file: '/tmp/out.pdf',
      }),
    ).toBe(true);

    await Promise.resolve();
    expect(progress.resumeStream).toHaveBeenCalledWith('run-1');
    expect(progress.runNewStream).toHaveBeenCalledWith('run-1');
    expect(progress.sendFollowUp.mock.calls[0]?.slice(0, 2)).toEqual([
      'run-1',
      'continue please',
    ]);
    expect(progress.openFile).toHaveBeenCalledWith('/tmp/out.tex', 4);
    expect(progress.openFileCompile).toHaveBeenCalledWith('/tmp/out.pdf');
  });

  it('passes pasted follow-up images through the desktop bridge', async () => {
    vi.doMock('@utils/files/pastedImageUtils', () => ({
      savePastedImageBase64: vi.fn(async () => '/tmp/pasted/fig.png'),
    }));
    try {
      const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
      const { savePastedImageBase64 } =
        await import('@utils/files/pastedImageUtils');
      const progress = createProgress();
      const ipc = createDesktopProgressIpc({ progress });

      expect(
        ipc.handleMessage({
          command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
          stream: 'run-1',
          text: 'look at this figure',
          images: [
            {
              base64: 'encoded',
              mediaType: 'image/png',
              fileName: 'pasted_1.png',
            },
          ],
        }),
      ).toBe(true);

      await Promise.resolve();
      await Promise.resolve();
      expect(savePastedImageBase64).toHaveBeenCalledWith(
        'encoded',
        'pasted_1.png',
      );
      expect(progress.sendFollowUp).toHaveBeenCalledWith(
        'run-1',
        'look at this figure',
        ['/tmp/pasted/fig.png'],
      );
    } finally {
      vi.doUnmock('@utils/files/pastedImageUtils');
    }
  });

  it('maps approval actions and reports desktop-only unsupported approval variants', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
        requestId: 'bash-1',
        action: 'approve',
      }),
    ).toBe(true);
    expect(progress.handleBashApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
      requestId: 'bash-1',
      action: 'approve',
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId: 'plan-1',
        action: 'reject',
        feedback: 'needs work',
      }),
    ).toBe(true);
    expect(progress.handlePlanApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
      approvalId: 'plan-1',
      action: 'reject',
      feedback: 'needs work',
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: 'edit-1',
        action: 'approve',
      }),
    ).toBe(true);
    expect(progress.handleToolEditApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-1',
      action: 'approve',
    });

    progress.handleToolEditApprovalAction.mockReturnValueOnce(false);
    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: 'edit-2',
        action: 'openDiff',
      }),
    ).toBe(true);
    expect(onUnsupportedCommand).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-2',
      action: 'openDiff',
    });
  });

  it('handles bypass toggles through shared policy instead of unsupported fallback', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
        stream: 'run-1',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
    expect(progress.runtimeHost.emit).toHaveBeenCalledWith(
      'updateToolEditApprovalBypassState',
      { streamId: 'run-1', bypassActive: true },
    );

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
        stream: 'run-2',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
    expect(progress.runtimeHost.emit).toHaveBeenCalledWith(
      'updateSuperYoloBypassState',
      { streamId: 'run-2', bypassActive: true },
    );
    expect(progress.runtimeHost.emit).toHaveBeenCalledWith(
      'updateToolEditApprovalBypassState',
      { streamId: 'run-2', bypassActive: true },
    );
  });

  it('routes agent proposal setup through the desktop bridge', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        proposalId: 'proposal-1',
        action: 'setup',
      }),
    ).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(progress.handleAgentProposalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
    });
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
  });

  it('does not report failed agent proposal setup as unsupported', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    progress.handleAgentProposalAction.mockResolvedValueOnce(false);
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        proposalId: 'proposal-1',
        action: 'setup',
      }),
    ).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(progress.handleAgentProposalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
    });
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
  });
});
