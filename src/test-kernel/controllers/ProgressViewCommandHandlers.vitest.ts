import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';

import {
  createProgressViewCommandHandlers as createSharedProgressViewCommandHandlers,
  createProgressViewSecondTierHandlers,
  type ProgressViewCommandActions,
  type ProgressViewSecondTierActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import type { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { submitProgressFollowUp } from '@controllers/progressView/progressFollowUpSubmit';
import type { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ProgressViewInboundMessageSchema,
  dispatchProgressViewInbound,
} from '@shared/schemas';
import type {
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
} from '@shared/schemas';
import { assertSupported, unsupported } from '@shared/utils/dispatcher';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

const externalInquiryMocks = vi.hoisted(() => ({
  continueExternalInquiryAction: vi.fn(),
  persistExternalInquiryAction: vi.fn(),
}));
const followUpMocks = vi.hoisted(() => ({
  notifyFollowUpSent: vi.fn(),
}));

vi.mock('@tools/inquiry/inquiryActions', () => externalInquiryMocks);
vi.mock('@agent/followUp/ToolUseFollowUp', () => followUpMocks);
vi.mock('@controllers/progressView/progressFollowUpSubmit', () => ({
  submitProgressFollowUp: vi.fn(async () => undefined),
}));
vi.mock('@utils/files/pastedImageUtils', () => ({
  savePastedImageBase64: vi.fn(),
}));

const savePastedImageBase64Mock = vi.mocked(savePastedImageBase64);
const submitProgressFollowUpMock = vi.mocked(submitProgressFollowUp);

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
      deleteStream: vi.fn(),
      deleteAllStreams: vi.fn(),
      stopStream: vi.fn(),
    },
    run: {
      state: { getRunMetadata: vi.fn(() => ({})) },
      runExecutionRequest: vi.fn(async () => {}),
    },
    file: {
      openFile: vi.fn(),
      openSpillArtifact: vi.fn(),
    },
    // Only the seven methods the command arms call; the rest of each
    // controller is exercised by its own suite.
    workflowFileActions: {
      openTaskStorage: vi.fn(),
      compareOriginal: vi.fn(),
      comparePrevious: vi.fn(),
      acceptFile: vi.fn(),
      mergeFile: vi.fn(),
      latexdiffFile: vi.fn(),
      openLabel: vi.fn(),
    } as unknown as ProgressWorkflowFileActionsController,
    agentProposal: {
      handleAction: vi.fn(),
    } as unknown as ProgressAgentProposalController,
    followUp: {
      captureAdmissionReporter: vi.fn(() => vi.fn()),
      reportImageSaveError: vi.fn(),
    },
    bypass: { showInfo: vi.fn() },
    approval: {
      approvePendingDelegatedWork: vi.fn(async () => undefined),
      handleToolEditApprovalAction: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
    },
    externalInquiry: {
      dismiss: vi.fn(),
    },
    ...overrides,
  };
}

function createSecondTierActions(
  overrides: Partial<ProgressViewSecondTierActions> = {},
): ProgressViewSecondTierActions {
  const polishReporter = {
    applyResult: vi.fn(),
    reportError: vi.fn(),
  };
  return {
    workflowRunActions: {
      diffStream: vi.fn(),
      runFileOperation: vi.fn(),
    },
    apiKeyRetry: {
      useOwnApiKey: vi
        .fn()
        .mockResolvedValue({ proceeded: false, retried: false }),
    },
    followUp: {
      planCompileFixerForStream: vi.fn(),
    },
    followUpPolish: {
      polishFollowUp: vi.fn(),
    },
    host: {
      showInfo: vi.fn(),
    },
    session: {
      executions: {
        requestManualCompaction: vi.fn(),
      },
    },
    getRunMetadata: vi.fn(() => ({
      identity: { kind: 'agent' as const, agent: 'chat' },
    })),
    restoreRunConfig: vi.fn(),
    applyFollowUpPlan: vi.fn(),
    capturePolishReporter: vi.fn(() => polishReporter),
    postToRenderer: vi.fn(),
    restoreProposalConfig: vi.fn(),
    retry: {
      submit: vi.fn(),
      cancel: vi.fn(),
    },
    transcriptExport: {
      pickFormat: vi.fn(),
      openPath: vi.fn(),
      showInfo: vi.fn(),
      showWarning: vi.fn(),
      showError: vi.fn(),
      getController: vi.fn(),
      getTraceViewerTemplate: vi.fn(() => '/tmp/trace-viewer/index.html'),
    },
    ...overrides,
  } as unknown as ProgressViewSecondTierActions;
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

function expectDispatched(
  message: ProgressViewInboundMessage,
  handlers: ProgressViewInboundHandlerRegistry,
): void {
  expect(dispatchProgressViewInbound(message, handlers)).toBe(true);
}

describe('createProgressViewCommandHandlers - follow-up', () => {
  beforeEach(() => {
    savePastedImageBase64Mock.mockReset();
    submitProgressFollowUpMock.mockClear();
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
    await vi.waitFor(() =>
      expect(submitProgressFollowUpMock).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-a',
          input: { text: 'continue' },
        }),
      ),
    );
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
    await vi.waitFor(() =>
      expect(submitProgressFollowUpMock).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-a',
          input: { text: 'look at these', mediaFiles: ['/tmp/pasted/a.png'] },
        }),
      ),
    );
  });
});

describe('createProgressViewCommandHandlers - bypass toggles', () => {
  afterEach(() => {
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
  });

  it('toggles file-edit and bash bypass independently', async () => {
    const stream = 'stream:edit-bypass';
    const session = createTestSession();
    const setApprovalBypassState = vi.fn();
    session.interactions.use({
      setApprovalBypassState,
      cancel: vi.fn(),
    });
    const showInfo = vi.fn();
    const handlers = createProgressViewCommandHandlers(
      createActions({
        bypass: { session, showInfo },
      }),
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream, session)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(false);
    expect(setApprovalBypassState).toHaveBeenCalledWith({
      streamId: stream,
      kind: 'toolEdit',
      bypassActive: true,
    });
    expect(showInfo).toHaveBeenCalledWith(
      'File edits will be auto-approved for this run.',
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_BASH_APPROVAL_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream, session)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(true);
    expect(setApprovalBypassState).toHaveBeenCalledWith({
      streamId: stream,
      kind: 'bash',
      bypassActive: true,
    });
    expect(showInfo).toHaveBeenCalledWith(
      'Shell commands will be auto-approved for this run.',
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream, session)).toBe(false);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(true);
    expect(setApprovalBypassState).toHaveBeenCalledWith({
      streamId: stream,
      kind: 'toolEdit',
      bypassActive: false,
    });
    session.dispose();
  });

  it.each([
    {
      kind: 'toolEdit' as const,
      editBypassed: true,
      bashBypassed: false,
      notice: 'File edits will be auto-approved for this run.',
    },
    {
      kind: 'bash' as const,
      editBypassed: false,
      bashBypassed: true,
      notice: 'Shell commands will be auto-approved for this run.',
    },
  ])(
    'grants only $kind bypass from its prompt',
    async ({ kind, editBypassed, bashBypassed, notice }) => {
      const stream = `stream:${kind}-prompt-grant`;
      const showInfo = vi.fn();
      const handlers = createProgressViewCommandHandlers(
        createActions({ bypass: { showInfo } }),
      );

      expectDispatched(
        {
          command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
          stream,
          kind,
        },
        handlers,
      );
      await Promise.resolve();

      expect(isApprovalBypassedForStream(stream)).toBe(editBypassed);
      expect(isBashApprovalBypassedForStream(stream)).toBe(bashBypassed);
      expect(showInfo).toHaveBeenCalledWith(notice);
    },
  );

  it('leaves an existing grant of its own kind untouched', async () => {
    // Set-on, never toggle: the header toggle or delegated inheritance can
    // already have granted edit bypass while this prompt was open.
    const stream = 'stream:yolo-enable';
    const handlers = createProgressViewCommandHandlers(
      createActions({ bypass: { showInfo: vi.fn() } }),
    );

    setToolEditApprovalSessionBypass(stream, true);

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
        stream,
        kind: 'toolEdit',
      },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(false);
  });

  it('makes delegated task bypass enable edit and bash bypasses', async () => {
    const stream = 'stream:proposal-bypass';
    const session = createTestSession();
    const setApprovalBypassState = vi.fn();
    session.interactions.use({
      setApprovalBypassState,
      cancel: vi.fn(),
    });
    const showInfo = vi.fn();
    const actions = createActions({
      bypass: { session, showInfo },
    });
    const handlers = createProgressViewCommandHandlers(actions);

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(proposalApprovals(session).isBypassed(stream)).toBe(true);
    expect(isApprovalBypassedForStream(stream, session)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(true);
    expect(setApprovalBypassState.mock.calls.map(([update]) => update)).toEqual(
      [
        { streamId: stream, kind: 'superYolo', bypassActive: true },
        { streamId: stream, kind: 'toolEdit', bypassActive: true },
        { streamId: stream, kind: 'bash', bypassActive: true },
      ],
    );
    expect(showInfo).toHaveBeenCalledWith(
      'Agent tasks, file edits, and shell commands will be auto-approved for this run.',
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS,
        stream,
        initiatingProposalId: 'proposal-current',
      },
      handlers,
    );
    await Promise.resolve();
    expect(proposalApprovals(session).isBypassed(stream)).toBe(true);
    expect(isApprovalBypassedForStream(stream, session)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(true);
    expect(actions.approval.approvePendingDelegatedWork).toHaveBeenCalledWith(
      stream,
      'proposal-current',
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(proposalApprovals(session).isBypassed(stream)).toBe(false);
    expect(isApprovalBypassedForStream(stream, session)).toBe(false);
    expect(isBashApprovalBypassedForStream(stream, session)).toBe(false);
    expect(
      setApprovalBypassState.mock.calls.slice(-3).map(([update]) => update),
    ).toEqual([
      { streamId: stream, kind: 'superYolo', bypassActive: false },
      { streamId: stream, kind: 'toolEdit', bypassActive: false },
      { streamId: stream, kind: 'bash', bypassActive: false },
    ]);
    expect(showInfo).toHaveBeenLastCalledWith(
      'Agent tasks, file edits, and shell commands will require approval for this run.',
    );
    session.dispose();
  });

  it.each([
    {
      label: 'AUTO-BASH',
      command: PROGRESS_VIEW_COMMANDS.TOGGLE_BASH_APPROVAL_BYPASS,
      expectEdit: true,
      expectBash: false,
    },
    {
      label: 'AUTO-EDIT',
      command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
      expectEdit: false,
      expectBash: true,
    },
  ])(
    'drops AUTO-TASK without revoking the other grant when $label is turned off',
    async ({ command, expectEdit, expectBash }) => {
      const stream = `stream:revoke-${expectBash ? 'bash' : 'edit'}`;
      const session = createTestSession();
      const handlers = createProgressViewCommandHandlers(
        createActions({
          bypass: { session, showInfo: vi.fn() },
        }),
      );

      expectDispatched(
        {
          command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
          stream,
        },
        handlers,
      );
      await Promise.resolve();

      expectDispatched({ command, stream }, handlers);
      await Promise.resolve();

      expect(proposalApprovals(session).isBypassed(stream)).toBe(false);
      expect(isApprovalBypassedForStream(stream, session)).toBe(expectEdit);
      expect(isBashApprovalBypassedForStream(stream, session)).toBe(expectBash);
      session.dispose();
    },
  );
});

describe('createProgressViewCommandHandlers - approvals', () => {
  it('routes progress approval commands to host actions', async () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: 'edit-1',
        action: 'approve',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
        requestId: 'bash-1',
        action: 'reject',
        feedback: 'needs a smaller command',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        requestId: 'plan-1',
        action: 'approve_and_goal',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
        requestId: 'question-1',
        action: 'submit',
        answers: { answer: 'yes' },
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        requestId: 'proposal-1',
        action: 'approve',
        agent: 'review',
        model: 'deepseek',
      },
      handlers,
    );

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
      requestId: 'plan-1',
      action: 'approve_and_goal',
    });
    expect(actions.approval.handleUserQuestionAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
      requestId: 'question-1',
      action: 'submit',
      answers: { answer: 'yes' },
    });
    expect(actions.agentProposal.handleAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      requestId: 'proposal-1',
      action: 'approve',
      agent: 'review',
      model: 'deepseek',
    });
  });
});

describe('external inquiry action schema', () => {
  const command = PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION;
  const threadId = 'ei_123456789abc';

  beforeEach(() => {
    externalInquiryMocks.continueExternalInquiryAction.mockReset();
    externalInquiryMocks.persistExternalInquiryAction.mockReset();
  });

  it.each([
    {
      name: 'submit',
      message: { command, action: 'submit' as const, threadId, answer: 'Yes' },
    },
    {
      name: 'drop',
      message: { command, action: 'drop' as const, threadId },
    },
  ])(
    'persists, dismisses, then continues a $name action',
    async ({ message }) => {
      const order: string[] = [];
      const transition = { kind: 'stale' as const, threadId };
      externalInquiryMocks.persistExternalInquiryAction.mockImplementation(
        async () => {
          order.push('persist');
          return transition;
        },
      );
      const dismiss = vi.fn(() => {
        order.push('dismiss');
      });
      externalInquiryMocks.continueExternalInquiryAction.mockImplementation(
        async () => {
          order.push('continue');
        },
      );
      const actions = createActions({ externalInquiry: { dismiss } });
      const handlers = createProgressViewCommandHandlers(actions);

      await assertSupported(handlers[command])(message);

      expect(order).toEqual(['persist', 'dismiss', 'continue']);
      expect(
        externalInquiryMocks.persistExternalInquiryAction,
      ).toHaveBeenCalledWith(message);
      expect(dismiss).toHaveBeenCalledWith(threadId);
      expect(
        externalInquiryMocks.continueExternalInquiryAction,
      ).toHaveBeenCalledWith(transition, actions.externalInquiry);
    },
  );
});

describe('createProgressViewSecondTierHandlers', () => {
  it('defines the complete shared second-tier command set', () => {
    const handlers = createProgressViewSecondTierHandlers(
      createSecondTierActions(),
    );

    expect(Object.keys(handlers).toSorted()).toEqual(
      [
        PROGRESS_VIEW_COMMANDS.DIFF_STREAM,
        PROGRESS_VIEW_COMMANDS.PACK_STREAM,
        PROGRESS_VIEW_COMMANDS.CLEAN_STREAM,
        PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
        PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY,
        PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
        PROGRESS_VIEW_COMMANDS.EXPORT_TRANSCRIPT,
        PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE,
        PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG,
        PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
        PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER,
      ].toSorted(),
    );
  });

  it('refuses transcript export when the stream has no execution id', async () => {
    const actions = createSecondTierActions();
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.EXPORT_TRANSCRIPT])({
      command: PROGRESS_VIEW_COMMANDS.EXPORT_TRANSCRIPT,
      stream: 'stream-1',
    });

    expect(actions.transcriptExport.pickFormat).not.toHaveBeenCalled();
    expect(actions.host.showInfo).toHaveBeenCalledWith(
      'This run has no saved transcript to export yet.',
    );
  });

  it('reports an unavailable retry through the host', async () => {
    const actions = createSecondTierActions();
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(
      handlers[PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST],
    )({
      command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
      stream: 'stream-1',
      requestId: 'request-1',
      feedback: 'Try once more',
    });

    expect(actions.retry.submit).toHaveBeenCalledWith(
      'stream-1',
      'request-1',
      'Try once more',
    );
    expect(actions.host.showInfo).toHaveBeenCalledWith(
      'No retryable request is available for this stream yet.',
    );
  });

  it('leaves restore failure reporting to the host callback', async () => {
    const failure = new Error('restore failed');
    const runConfig = {};
    const getRunMetadata = vi.fn().mockReturnValue({
      config: runConfig,
      identity: { kind: 'agent', agent: 'chat' },
    });
    const actions = createSecondTierActions({
      getRunMetadata,
      restoreRunConfig: vi.fn().mockRejectedValue(failure),
    });
    const handlers = createProgressViewSecondTierHandlers(actions);

    await expect(
      assertSupported(handlers[PROGRESS_VIEW_COMMANDS.RESTORE_STATE])({
        command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
        stream: 'stream-1',
      }),
    ).rejects.toBe(failure);
    expect(getRunMetadata).toHaveBeenCalledOnce();
    expect(actions.restoreRunConfig).toHaveBeenCalledWith(runConfig);
  });

  it.each([
    [{ kind: 'multiAgentWorkflow' as const, workflowName: 'engineer' }],
    [{ kind: 'process' as const, tool: 'bash' }],
    [{ kind: 'agent' as const, agent: 'coder', tool: 'codex' }],
  ])(
    'refuses RESTORE_STATE with feedback for non-native identity %j',
    async (identity) => {
      const actions = createSecondTierActions({
        getRunMetadata: vi.fn().mockReturnValue({ config: {}, identity }),
      });
      const handlers = createProgressViewSecondTierHandlers(actions);

      await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.RESTORE_STATE])({
        command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
        stream: 'stream-1',
      });

      expect(actions.restoreRunConfig).not.toHaveBeenCalled();
      expect(actions.host.showInfo).toHaveBeenCalledWith(
        expect.stringContaining('Only TeXRA agent runs'),
      );
    },
  );

  it('notifies compaction through the execution owner session', async () => {
    const ownerSession = {};
    const actions = createSecondTierActions({
      session: {
        executions: {
          requestManualCompaction: vi.fn().mockReturnValue({
            kind: 'requested',
            streamId: 'stream-1',
            session: ownerSession,
          }),
        },
      } as unknown as ProgressViewSecondTierActions['session'],
    });
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE])({
      command: PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE,
      stream: 'stream-1',
    });

    expect(followUpMocks.notifyFollowUpSent).toHaveBeenCalledWith(
      'stream-1',
      ownerSession,
    );
  });

  it('skips polishing when the stream has no run config', async () => {
    const actions = createSecondTierActions({
      getRunMetadata: vi.fn().mockReturnValue({}),
    });
    const reporter = actions.capturePolishReporter();
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP])({
      command: PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
      stream: 'stream-1',
      text: 'Improve this',
    });

    expect(actions.followUpPolish.polishFollowUp).not.toHaveBeenCalled();
    expect(reporter.applyResult).not.toHaveBeenCalled();
  });

  it('awaits polish error reporting', async () => {
    const polishFailure = new Error('polish failed');
    const reportingFailure = new Error('reporting failed');
    const reportError = vi.fn().mockRejectedValue(reportingFailure);
    const actions = createSecondTierActions({
      getRunMetadata: vi.fn().mockReturnValue({ config: {} }),
      followUpPolish: {
        polishFollowUp: vi.fn().mockRejectedValue(polishFailure),
      } as unknown as ProgressViewSecondTierActions['followUpPolish'],
      capturePolishReporter: vi.fn(() => ({
        applyResult: vi.fn(),
        reportError,
      })),
    });
    const handlers = createProgressViewSecondTierHandlers(actions);

    await expect(
      assertSupported(handlers[PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP])({
        command: PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
        stream: 'stream-1',
        text: 'Improve this',
      }),
    ).rejects.toBe(reportingFailure);
    expect(reportError).toHaveBeenCalledWith('stream-1', polishFailure);
  });

  it('reports polish stages around the controller call', async () => {
    const order: string[] = [];
    const polishResult = { kind: 'skipped' };
    const applyResult = vi.fn(async () => {
      order.push('apply');
    });
    const actions = createSecondTierActions({
      getRunMetadata: vi.fn().mockReturnValue({ config: {} }),
      followUpPolish: {
        polishFollowUp: vi.fn(async () => {
          order.push('polish');
          return polishResult;
        }),
      } as unknown as ProgressViewSecondTierActions['followUpPolish'],
      capturePolishReporter: vi.fn(() => ({
        applyResult,
        reportError: vi.fn(),
      })),
      onPolishProgress: vi.fn((message: string) => {
        order.push(`progress:${message}`);
      }),
    });
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP])({
      command: PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
      stream: 'stream-1',
      text: 'Improve this',
    });

    expect(order).toEqual([
      'progress:Sending to AI for polishing...',
      'polish',
      'progress:Applying changes...',
      'apply',
    ]);
    expect(applyResult).toHaveBeenCalledWith(polishResult);
  });

  it('polishes without a progress reporter when the host has none', async () => {
    const polishResult = { kind: 'skipped' };
    const actions = createSecondTierActions({
      getRunMetadata: vi.fn().mockReturnValue({ config: {} }),
      followUpPolish: {
        polishFollowUp: vi.fn().mockResolvedValue(polishResult),
      } as unknown as ProgressViewSecondTierActions['followUpPolish'],
    });
    const reporter = actions.capturePolishReporter();
    const handlers = createProgressViewSecondTierHandlers(actions);

    await assertSupported(handlers[PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP])({
      command: PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
      stream: 'stream-1',
      text: 'Improve this',
    });

    expect(reporter.applyResult).toHaveBeenCalledWith(polishResult);
    expect(reporter.reportError).not.toHaveBeenCalled();
  });
});
