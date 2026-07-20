// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  createProgressViewCommandHandlers as createSharedProgressViewCommandHandlers,
  type ProgressViewCommandActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ProgressViewInboundMessageSchema,
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { assertSupported, unsupported } from '@shared/utils/dispatcher';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  cleanupAllApprovals,
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

vi.mock('@tools/inquiry', () => externalInquiryMocks);
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
      approvePendingDelegatedWork: vi.fn(async () => undefined),
      handleToolEditApprovalAction: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    },
    externalInquiry: {
      dismiss: vi.fn(),
    },
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

function expectDispatched(
  message: ProgressViewInboundMessage,
  handlers: ProgressViewInboundHandlerRegistry,
): void {
  expect(dispatchProgressViewInbound(message, handlers)).toBe(true);
}

describe('createProgressViewCommandHandlers', () => {
  it('routes lifecycle commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, stream: 'stream-a' },
      handlers,
    );
    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, filter: 'all' },
      handlers,
    );
    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM, stream: 'stream-b' },
      handlers,
    );
    expectDispatched({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL }, handlers);
    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.STOP_STREAM, stream: 'stream-c' },
      handlers,
    );

    expect(actions.lifecycle.setActiveStream).toHaveBeenCalledWith('stream-a');
    expect(actions.lifecycle.setAgentFilter).toHaveBeenCalledWith('all');
    expect(actions.lifecycle.deleteStream).toHaveBeenCalledWith('stream-b');
    expect(actions.lifecycle.deleteAllStreams).toHaveBeenCalledWith();
    expect(actions.lifecycle.stopStream).toHaveBeenCalledWith('stream-c');
  });

  it('routes run-control commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.RESUME, stream: 'stream-a' },
      handlers,
    );
    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.RUN_NEW, stream: 'stream-b' },
      handlers,
    );

    expect(actions.run.resumeStream).toHaveBeenCalledWith('stream-a');
    expect(actions.run.runNewStream).toHaveBeenCalledWith('stream-b');
  });

  it('routes file commands to host actions', () => {
    const actions = createActions();
    const handlers = createProgressViewCommandHandlers(actions);

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: 'paper.tex',
        line: 12,
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE,
        file: 'paper.tex',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE,
        stream: 'stream-a',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL,
        file: 'edited.tex',
        base: 'paper.tex',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
        file: 'edited.tex',
        base: 'paper.tex',
        prev: 'previous.tex',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.ACCEPT_FILE,
        file: 'edited.tex',
        base: 'paper.tex',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.MERGE_FILE,
        file: 'edited.tex',
        base: 'paper.tex',
      },
      handlers,
    );
    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE,
        file: 'edited.tex',
        base: 'paper.tex',
      },
      handlers,
    );
    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.OPEN_LABEL, label: 'thm:main' },
      handlers,
    );

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

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
        stream,
      },
      handlers,
    );
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
      'File edits and shell commands will be auto-approved for this run.',
    );

    expectDispatched(
      {
        command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
        stream,
      },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(false);
    expect(isBashApprovalBypassedForStream(stream)).toBe(false);
    expect(events.at(-1)).toEqual({
      event: 'updateToolEditApprovalBypassState',
      payload: { streamId: stream, bypassActive: false },
    });
  });

  it('forces edit and bash bypass on without inverting a decoupled stream', async () => {
    // Reproduces the inline run-approval path on a delegated child
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

    expectDispatched(
      { command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS, stream },
      handlers,
    );
    await Promise.resolve();

    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(true);
    expect(showInfo).toHaveBeenCalledWith(
      'File edits and shell commands will be auto-approved for this run.',
    );
  });

  it('makes delegated task bypass enable edit and bash bypasses', async () => {
    const stream = 'stream:proposal-bypass';
    const { events, host } = createRecordingRuntimeHost();
    const showInfo = vi.fn();
    const actions = createActions({
      bypass: { runtimeHost: host, showInfo },
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

    expect(proposalApprovals().isBypassed(stream)).toBe(true);
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
    expect(proposalApprovals().isBypassed(stream)).toBe(true);
    expect(isApprovalBypassedForStream(stream)).toBe(true);
    expect(isBashApprovalBypassedForStream(stream)).toBe(true);
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

    expect(proposalApprovals().isBypassed(stream)).toBe(false);
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
    expect(showInfo).toHaveBeenLastCalledWith(
      'Agent tasks, file edits, and shell commands will require approval for this run.',
    );
  });
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
        approvalId: 'plan-1',
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
        proposalId: 'proposal-1',
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
      action: 'approve',
      agent: 'review',
      model: 'deepseek',
    });
  });
});

describe('permission action schemas', () => {
  const tool = {
    command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
    requestId: 'edit-1',
  };
  const bash = {
    command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
    requestId: 'bash-1',
  };
  const proposal = {
    command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
    proposalId: 'proposal-1',
  };
  const plan = {
    command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
    approvalId: 'plan-1',
  };

  it.each([
    ['tool approve', { ...tool, action: 'approve' }, true],
    ['tool reject', { ...tool, action: 'reject', feedback: 'No' }, true],
    ['tool open diff', { ...tool, action: 'openDiff' }, true],
    ['tool show latexdiff', { ...tool, action: 'showLatexdiff' }, true],
    ['tool preview proposed', { ...tool, action: 'previewProposed' }, true],
    [
      'tool approve with feedback',
      { ...tool, action: 'approve', feedback: 'x' },
      false,
    ],
    [
      'tool inspection with feedback',
      { ...tool, action: 'openDiff', feedback: 'x' },
      false,
    ],
    ['tool unknown field', { ...tool, action: 'approve', extra: true }, false],
    ['bash approve', { ...bash, action: 'approve' }, true],
    ['bash reject', { ...bash, action: 'reject', feedback: 'No' }, true],
    ['bash tool action', { ...bash, action: 'openDiff' }, false],
    [
      'bash approve with feedback',
      { ...bash, action: 'approve', feedback: 'x' },
      false,
    ],
    ['bash unknown field', { ...bash, action: 'reject', extra: true }, false],
    [
      'proposal approve',
      { ...proposal, action: 'approve', model: 'm', agent: 'a' },
      true,
    ],
    [
      'proposal reject',
      { ...proposal, action: 'reject', feedback: 'No' },
      true,
    ],
    ['proposal setup', { ...proposal, action: 'setup' }, true],
    [
      'proposal approve with feedback',
      { ...proposal, action: 'approve', feedback: 'x' },
      false,
    ],
    [
      'proposal reject with model',
      { ...proposal, action: 'reject', model: 'm' },
      false,
    ],
    [
      'proposal setup with agent',
      { ...proposal, action: 'setup', agent: 'a' },
      false,
    ],
    [
      'proposal unknown field',
      { ...proposal, action: 'setup', extra: true },
      false,
    ],
    ['plan approve', { ...plan, action: 'approve' }, true],
    ['plan approve and run', { ...plan, action: 'approve_and_goal' }, true],
    ['plan reject', { ...plan, action: 'reject', feedback: 'No' }, true],
    [
      'plan approve with feedback',
      { ...plan, action: 'approve', feedback: 'x' },
      false,
    ],
    [
      'plan run with feedback',
      { ...plan, action: 'approve_and_goal', feedback: 'x' },
      false,
    ],
    ['plan unknown field', { ...plan, action: 'reject', extra: true }, false],
  ])('%s parses as %s', (_name, message, valid) => {
    expect(ProgressViewInboundMessageSchema.safeParse(message).success).toBe(
      valid,
    );
  });
});

describe('external inquiry action schema', () => {
  const command = PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION;
  const threadId = 'ei_123456789abc';

  beforeEach(() => {
    externalInquiryMocks.continueExternalInquiryAction.mockReset();
    externalInquiryMocks.persistExternalInquiryAction.mockReset();
  });

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

describe('user question action schema', () => {
  const command = PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION;
  const requestId = 'question-1';

  it.each([
    {
      name: 'submit with answers',
      message: {
        command,
        requestId,
        action: 'submit',
        answers: { choice: 'A' },
      },
      valid: true,
    },
    {
      name: 'reject with feedback',
      message: { command, requestId, action: 'reject', feedback: 'Not now' },
      valid: true,
    },
    {
      name: 'skip without feedback',
      message: { command, requestId, action: 'skip' },
      valid: true,
    },
    {
      name: 'submit without answers',
      message: { command, requestId, action: 'submit' },
      valid: false,
    },
    {
      name: 'submit with rejection feedback',
      message: {
        command,
        requestId,
        action: 'submit',
        answers: { choice: 'A' },
        feedback: 'contradictory',
      },
      valid: false,
    },
    {
      name: 'reject with answers',
      message: {
        command,
        requestId,
        action: 'reject',
        answers: { choice: 'A' },
      },
      valid: false,
    },
    {
      name: 'skip with answers',
      message: {
        command,
        requestId,
        action: 'skip',
        answers: { choice: 'A' },
      },
      valid: false,
    },
  ])('$name is $valid', ({ message, valid }) => {
    expect(ProgressViewInboundMessageSchema.safeParse(message).success).toBe(
      valid,
    );
  });
});
