// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  createProgressViewCommandHandlers as createSharedProgressViewCommandHandlers,
  type ProgressViewCommandActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ProgressViewInboundMessageSchema,
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { assertSupported, unsupported } from '@shared/utils/dispatcher';
import {
  cleanupAllApprovals,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovalState,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

vi.mock('@utils/files/pastedImageUtils', () => ({
  savePastedImageBase64: vi.fn(),
}));

const savePastedImageBase64Mock = vi.mocked(savePastedImageBase64);

/**
 * `createProgressViewCommandHandlers` returns only the cross-host shared
 * subset of commands (see its `satisfies Partial<...>` return). Each real
 * host pads the rest with its own handlers or `unsupported(...)`; this test
 * only exercises the shared subset, so it pads the remainder with a generic
 * unsupported marker to satisfy dispatchProgressViewInbound's exhaustive
 * registry type.
 */
function createProgressViewCommandHandlers(
  actions: ProgressViewCommandActions,
): ProgressViewInboundHandlerRegistry {
  const shared = createSharedProgressViewCommandHandlers(actions);
  const full: Record<string, unknown> = {};
  for (const command of new Set(Object.values(PROGRESS_VIEW_COMMANDS))) {
    full[command] =
      (shared as Record<string, unknown>)[command] ??
      unsupported('not covered by this test');
  }
  return full as ProgressViewInboundHandlerRegistry;
}

function createActions(
  overrides: Partial<ProgressViewCommandActions> = {},
): ProgressViewCommandActions {
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
      onUnsupportedToolEditApproval: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    },
    externalInquiry: {},
    ...overrides,
  };
}

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

type SendFollowUpMessage = Extract<
  ProgressViewInboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP }
>;

function parseSendFollowUpMessage(message: unknown): SendFollowUpMessage {
  const parsed = ProgressViewInboundMessageSchema.parse(message);
  if (parsed.command !== PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP) {
    throw new Error(`Expected SEND_FOLLOW_UP, got ${parsed.command}`);
  }
  return parsed;
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

describe('createProgressViewCommandHandlers - follow-up', () => {
  beforeEach(() => {
    savePastedImageBase64Mock.mockReset();
  });

  it('routes text-only follow-ups to the host action', async () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP])(
      parseSendFollowUpMessage({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-a',
        text: 'continue',
      }),
    );

    expect(savePastedImageBase64Mock).not.toHaveBeenCalled();
    expect(actions.followUp.reportImageSaveError).not.toHaveBeenCalled();
    expect(actions.followUp.sendFollowUp).toHaveBeenCalledWith({
      stream: 'stream-a',
      text: 'continue',
    });
  });

  it('persists follow-up images and keeps sending text after an image save fails', async () => {
    const failedImageError = new Error('bad image');
    savePastedImageBase64Mock
      .mockResolvedValueOnce('/tmp/pasted/a.png')
      .mockRejectedValueOnce(failedImageError);

    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);
    const failedImage = {
      base64: 'broken',
      mediaType: 'image/png',
      fileName: 'pasted_2.png',
    };

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP])(
      parseSendFollowUpMessage({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-a',
        text: 'look at these',
        images: [
          {
            base64: 'ok',
            mediaType: 'image/png',
            fileName: 'pasted_1.png',
          },
          failedImage,
        ],
      }),
    );

    expect(savePastedImageBase64Mock).toHaveBeenNthCalledWith(
      1,
      'ok',
      'pasted_1.png',
    );
    expect(savePastedImageBase64Mock).toHaveBeenNthCalledWith(
      2,
      'broken',
      'pasted_2.png',
    );
    expect(actions.followUp.reportImageSaveError).toHaveBeenCalledWith(
      failedImage,
      failedImageError,
    );
    expect(actions.followUp.sendFollowUp).toHaveBeenCalledWith({
      stream: 'stream-a',
      text: 'look at these',
      mediaFiles: ['/tmp/pasted/a.png'],
    });
  });
});

describe('createProgressViewCommandHandlers - bypass toggles', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('keeps tool-edit and bash bypass symmetric behind the edit shield', async () => {
    const stream = 'stream:edit-bypass';
    const { events, host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const handlers = createProgressViewCommandHandlers(
      createActions({ bypass: { runtimeHost: host, showInfo } }),
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

  it('forces edit and bash bypass on without inverting a decoupled stream', async () => {
    // Reproduces the inline "Yolo (this session)" path on a delegated child
    // stream where edit-YOLO was granted but bash stayed gated. A toggle would
    // flip edit OFF; ENABLE_APPROVAL_BYPASS must force both ON.
    const stream = 'stream:yolo-enable';
    const { host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const handlers = createProgressViewCommandHandlers(
      createActions({ bypass: { runtimeHost: host, showInfo } }),
    );

    setToolEditApprovalSessionBypass(stream, true, host);
    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(false);

    expect(
      dispatchProgressViewInbound(
        { command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS, stream },
        handlers,
      ),
    ).toBe(true);
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(true);
    expect(showInfo).toHaveBeenCalledWith(
      'YOLO mode enabled: Tool actions and bash commands will be auto-approved for this stream.',
    );
  });

  it('makes delegated task bypass enable edit and bash bypasses', async () => {
    const stream = 'stream:proposal-bypass';
    const { events, host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const handlers = createProgressViewCommandHandlers(
      createActions({ bypass: { runtimeHost: host, showInfo } }),
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

    expect(proposalApprovalState.isBypassed(stream)).toBe(true);
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

    expect(proposalApprovalState.isBypassed(stream)).toBe(false);
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

describe('createProgressViewCommandHandlers - approvals', () => {
  it('routes progress approval commands to host actions', async () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-1',
          action: 'approve',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
          requestId: 'bash-1',
          action: 'reject',
          feedback: 'needs a smaller command',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
          approvalId: 'plan-1',
          action: 'approve_and_goal',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
          requestId: 'question-1',
          action: 'submit',
          answers: { answer: 'yes' },
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: 'proposal-1',
          action: 'setup',
          agent: 'review',
          model: 'deepseek',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.approval.handleToolEditApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-1',
      action: 'approve',
    });
    expect(actions.approval.handleBashApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
      requestId: 'bash-1',
      action: 'reject',
      feedback: 'needs a smaller command',
    });
    expect(actions.approval.handlePlanApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
      approvalId: 'plan-1',
      action: 'approve_and_goal',
    });
    expect(actions.approval.handleUserQuestionAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
      requestId: 'question-1',
      action: 'submit',
      answers: { answer: 'yes' },
    });
    expect(actions.approval.handleAgentProposalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
      agent: 'review',
      model: 'deepseek',
    });
    expect(
      actions.approval.onUnsupportedToolEditApproval,
    ).not.toHaveBeenCalled();
  });

  it('reports unsupported tool-edit approval actions when the host returns false', async () => {
    const actions = createActions();
    actions.approval.handleToolEditApprovalAction = vi.fn(() => false);
    const handlers = createProgressViewCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-2',
          action: 'openDiff',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.approval.onUnsupportedToolEditApproval).toHaveBeenCalledWith(
      {
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: 'edit-2',
        action: 'openDiff',
      },
    );
  });

  it('reports unsupported tool-edit approval actions from async host results', async () => {
    const actions = createActions();
    actions.approval.handleToolEditApprovalAction = vi.fn(() =>
      Promise.resolve(false),
    );
    const handlers = createProgressViewCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-3',
          action: 'approve',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.approval.onUnsupportedToolEditApproval).toHaveBeenCalledWith(
      {
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: 'edit-3',
        action: 'approve',
      },
    );
  });

  it('does not report unsupported tool-edit approval actions from async handled results', async () => {
    const actions = createActions();
    actions.approval.handleToolEditApprovalAction = vi.fn(() =>
      Promise.resolve(true),
    );
    const handlers = createProgressViewCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-4',
          action: 'reject',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(
      actions.approval.onUnsupportedToolEditApproval,
    ).not.toHaveBeenCalled();
  });
});

describe('external inquiry action schema', () => {
  const command = PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION;
  const threadId = 'ei_123456789abc';

  it("requires each action variant's own fields", () => {
    const results = [
      { command, action: 'submit', threadId, answer: 'Confirmed' },
      { command, action: 'drop', threadId },
      { command, action: 'draft', threadId, draft: null },
      { command, action: 'submit', threadId },
      { command, action: 'draft', threadId },
    ].map(
      (message) => ProgressViewInboundMessageSchema.safeParse(message).success,
    );

    expect(results).toEqual([true, true, true, false, false]);
  });
});
