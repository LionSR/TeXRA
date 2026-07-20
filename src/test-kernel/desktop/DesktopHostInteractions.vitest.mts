// Test support imports

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type {
  BashSettlement,
  HostBashApprovalResult,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  StreamTabId,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopHostInteractions {
  approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
  requestToolEditApproval(request: {
    path: string;
    originalContent: string;
    proposedContent: string;
    sourceTool: string;
    streamId?: StreamTabId;
  }): Promise<{ accepted: boolean }>;
  requestBashApproval(request: {
    command: string;
    streamId?: StreamTabId;
  }): Promise<{ accepted: boolean; userMessage?: string }>;
  requestPlanApproval(request: {
    approvalId: string;
    streamId: StreamTabId;
    goalEnabled: boolean;
    plan: { objective: string };
  }): Promise<unknown>;
  requestAgentProposal(request: unknown): Promise<unknown>;
  submitBashDecision(requestId: string, decision: BashSettlement): boolean;
  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean;
  submitProposalDecision(requestId: string, decision: ProposalResult): boolean;
  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean;
  cancel(selector?: {
    streamId?: StreamTabId | null;
    kind?: string;
    cause?: string;
  }): void;
  dispose?(): void;
}

interface DesktopHostInteractionsModule {
  createDesktopHostInteractions(options: {
    runtimeHost: { emit: (event: string, payload: unknown) => void };
    session: SessionHandle;
    showInfoMessage(message: string): Promise<void> | void;
    getApprovalHandlers(): ApprovalRequestHandlerSet;
    getToolEditApprovals(): {
      approvePendingForStream: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      requestApproval: ReturnType<typeof vi.fn>;
    };
  }): DesktopHostInteractions;
}

type ShowSpy<T> = ReturnType<typeof vi.fn<(item: T) => void>>;
type DismissSpy = ReturnType<typeof vi.fn<(id: string) => void>>;

interface RecordingTransport<T> {
  readonly show: ShowSpy<T>;
  readonly dismiss: DismissSpy;
}

interface RecordingApprovalHandlerSet extends ApprovalRequestHandlerSet {
  readonly transport: {
    toolEdit: RecordingTransport<ToolEditPermission>;
    bash: RecordingTransport<BashPermission>;
    retry: RecordingTransport<RetryPermission>;
    agentProposal: RecordingTransport<AgentProposalPermission>;
    planApproval: RecordingTransport<PlanApprovalPermission>;
    externalInquiry: RecordingTransport<ExternalInquiryPermission>;
    userQuestion: RecordingTransport<UserQuestionPermission>;
  };
}

function handler<
  T extends { streamId: string },
  K extends keyof T,
  Result = never,
>(
  idField: K,
): {
  handler: ApprovalRequestHandler<T, K, Result>;
  transport: RecordingTransport<T>;
} {
  const transport = {
    show: vi.fn<(item: T) => void>(),
    dismiss: vi.fn<(id: string) => void>(),
  };
  return {
    handler: new ApprovalRequestHandler<T, K, Result>(
      idField,
      transport.show,
      transport.dismiss,
      () => true,
    ),
    transport,
  };
}

function createHandlers(): RecordingApprovalHandlerSet {
  const toolEdit = handler<ToolEditPermission, 'requestId'>('requestId');
  const bash = handler<BashPermission, 'requestId', HostBashApprovalResult>(
    'requestId',
  );
  const retry = handler<RetryPermission, 'streamId', RetryResult>('streamId');
  const agentProposal = handler<
    AgentProposalPermission,
    'proposalId',
    ProposalResult
  >('proposalId');
  const planApproval = handler<
    PlanApprovalPermission,
    'approvalId',
    PlanApprovalResult
  >('approvalId');
  const externalInquiry = handler<ExternalInquiryPermission, 'requestId'>(
    'requestId',
  );
  const userQuestion = handler<
    UserQuestionPermission,
    'requestId',
    HostUserQuestionResult
  >('requestId');

  return {
    toolEdit: toolEdit.handler,
    bash: bash.handler,
    retry: retry.handler,
    agentProposal: agentProposal.handler,
    planApproval: planApproval.handler,
    externalInquiry: externalInquiry.handler,
    userQuestion: userQuestion.handler,
    transport: {
      toolEdit: toolEdit.transport,
      bash: bash.transport,
      retry: retry.transport,
      agentProposal: agentProposal.transport,
      planApproval: planApproval.transport,
      externalInquiry: externalInquiry.transport,
      userQuestion: userQuestion.transport,
    },
  };
}

/** Reads the `requestId` passed to a handler's first `.show()` call. */
function firstShowRequestId(show: ReturnType<typeof vi.fn>): string {
  const requestId = (
    show.mock.calls[0]?.[0] as { requestId?: string } | undefined
  )?.requestId;
  if (!requestId) throw new Error('Expected a captured requestId.');
  return requestId;
}

async function createInteractions(handlers = createHandlers()) {
  const { createDesktopHostInteractions } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopHostInteractions.ts'))
  )) as DesktopHostInteractionsModule;
  const runtimeHost = { emit: vi.fn() };
  const session = createTestSession();
  const toolEditApprovals = {
    approvePendingForStream: vi.fn(async (): Promise<void> => {}),
    cancel: vi.fn(),
    requestApproval: vi.fn(async () => ({ accepted: true })),
  };
  const sessionEvents: SessionEvent[] = [];
  session.events.subscribe((event) => sessionEvents.push(event), {
    scope: 'session',
  });

  return {
    interactions: createDesktopHostInteractions({
      runtimeHost,
      session,
      showInfoMessage: vi.fn(),
      getApprovalHandlers: () => handlers,
      getToolEditApprovals: () => toolEditApprovals,
    }),
    handlers,
    runtimeHost,
    sessionEvents,
    session,
    toolEditApprovals,
  };
}

describe('createDesktopHostInteractions', () => {
  it('approves already-pending delegated work only in the selected stream', async () => {
    const { interactions, handlers, toolEditApprovals } =
      await createInteractions();
    const current = interactions.requestAgentProposal({
      proposalId: 'proposal-current',
      streamId: 'stream-a',
    });
    const parallel = interactions.requestAgentProposal({
      proposalId: 'proposal-parallel',
      streamId: 'stream-a',
    });
    const bash = interactions.requestBashApproval({
      command: 'lake build',
      streamId: 'stream-a',
    });
    const other = interactions.requestBashApproval({
      command: 'npm test',
      streamId: 'stream-b',
    });
    let releaseToolEdits: (() => void) | undefined;
    toolEditApprovals.approvePendingForStream.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseToolEdits = resolve;
      }),
    );

    let approvalCompleted = false;
    const approval = interactions.approvePendingDelegatedWork(
      'stream-a',
      'proposal-current',
    );
    void approval.then(() => {
      approvalCompleted = true;
    });

    await vi.waitFor(() =>
      expect(toolEditApprovals.approvePendingForStream).toHaveBeenCalledWith(
        'stream-a',
      ),
    );
    expect(approvalCompleted).toBe(false);
    releaseToolEdits?.();
    await approval;

    await expect(parallel).resolves.toEqual({ action: 'approve' });
    await expect(bash).resolves.toEqual({
      accepted: true,
      userMessage: undefined,
    });
    expect(handlers.transport.agentProposal.dismiss).toHaveBeenCalledWith(
      'proposal-parallel',
    );

    expect(
      interactions.submitProposalDecision('proposal-current', {
        action: 'approve',
      }),
    ).toBe(true);
    const streamBRequestId = (
      handlers.transport.bash.show.mock.calls.find(
        ([request]) => request.streamId === 'stream-b',
      )?.[0] as { requestId?: string } | undefined
    )?.requestId;
    expect(streamBRequestId).toBeDefined();
    expect(
      interactions.submitBashDecision(streamBRequestId!, {
        action: 'reject',
      }),
    ).toBe(true);
    await expect(current).resolves.toEqual({ action: 'approve' });
    await expect(other).resolves.toEqual({
      accepted: false,
      userMessage: undefined,
    });
  });

  it('delegates tool edit approvals to the window controller', async () => {
    const { interactions, toolEditApprovals } = await createInteractions();
    const request = {
      path: '/workspace/paper.tex',
      originalContent: 'old',
      proposedContent: 'new',
      sourceTool: 'edit',
      streamId: 'stream-a' as StreamTabId,
    };

    await expect(
      interactions.requestToolEditApproval(request),
    ).resolves.toEqual({ accepted: true });
    // The controller owns its window session (options.session), so the call
    // carries only the request.
    expect(toolEditApprovals.requestApproval).toHaveBeenCalledWith(request);
  });

  it('rejects a plan decision for a pending bash request', async () => {
    const handlers = createHandlers();
    const { interactions, runtimeHost, sessionEvents } =
      await createInteractions(handlers);

    const resultPromise = interactions.requestBashApproval({
      command: 'echo hi',
      streamId: 'stream-a' as StreamTabId,
    });
    const requestId = firstShowRequestId(handlers.transport.bash.show);

    expect(
      interactions.submitPlanDecision(requestId, { action: 'approve' }),
    ).toBe(false);

    expect(
      interactions.submitBashDecision(requestId, { action: 'approve' }),
    ).toBe(true);
    await expect(resultPromise).resolves.toEqual({ accepted: true });
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'requestEnsureProgressView',
      {},
    );
    expect(runtimeHost.emit).not.toHaveBeenCalledWith(
      'setActiveStream',
      expect.anything(),
    );
    // Interaction requests register the stream without yanking the active
    // tab away from what the user is viewing (#8246).
    expect(sessionEvents).toContainEqual({
      scope: 'session',
      event: {
        type: 'setActiveStream',
        payload: {
          streamId: 'stream-a',
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
    });
  });

  it('forwards a cancellation cause as bash reject feedback', async () => {
    const handlers = createHandlers();
    const { interactions, toolEditApprovals } =
      await createInteractions(handlers);

    const resultPromise = interactions.requestBashApproval({
      command: 'rm -rf build',
      streamId: 'stream-a' as StreamTabId,
    });

    interactions.cancel({
      streamId: 'stream-a' as StreamTabId,
      cause: 'Stream resources released.',
    });

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
    expect(handlers.transport.bash.dismiss).toHaveBeenCalled();
    expect(toolEditApprovals.cancel).toHaveBeenCalledWith({
      streamId: 'stream-a',
      cause: 'Stream resources released.',
    });
  });

  it('can cancel synchronously while presenting a request', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);
    handlers.transport.bash.show.mockImplementation(() => {
      interactions.cancel({
        kind: 'bash',
        streamId: 'stream-sync' as StreamTabId,
        cause: 'Stopped during presentation.',
      });
    });

    const result = interactions.requestBashApproval({
      command: 'echo pending',
      streamId: 'stream-sync' as StreamTabId,
    });

    await expect(result).resolves.toEqual({
      accepted: false,
      userMessage: 'Stopped during presentation.',
    });
  });

  it('routes tool-edit cancellation to the window controller', async () => {
    const { interactions, toolEditApprovals } = await createInteractions();

    interactions.cancel({
      kind: 'toolEdit',
      streamId: 'stream-a' as StreamTabId,
      cause: 'Owning execution ended.',
    });

    expect(toolEditApprovals.cancel).toHaveBeenCalledWith({
      kind: 'toolEdit',
      streamId: 'stream-a',
      cause: 'Owning execution ended.',
    });
  });

  it('preserves a bash timeout resolution as distinct from rejection', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);

    const resultPromise = interactions.requestBashApproval({
      command: 'sleep 10',
      streamId: 'stream-a' as StreamTabId,
    });
    const requestId = firstShowRequestId(handlers.transport.bash.show);

    expect(
      interactions.submitBashDecision(requestId, { action: 'timeout' }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      timedOut: true,
    });
    expect(handlers.transport.bash.dismiss).toHaveBeenCalledWith(requestId);
  });

  it('preserves typed proposal approval overrides', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);

    const resultPromise = interactions.requestAgentProposal({
      proposalId: 'proposal-a',
      streamId: 'stream-a' as StreamTabId,
      agentCategory: 'toolUse',
      agent: 'demo-agent',
    });

    expect(
      interactions.submitProposalDecision('proposal-a', {
        action: 'approve',
        model: 'openai:gpt-5',
        agent: 'configured-agent',
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'approve',
      model: 'openai:gpt-5',
      agent: 'configured-agent',
    });
    expect(handlers.transport.agentProposal.dismiss).toHaveBeenCalledWith(
      'proposal-a',
    );
  });

  it('cancels all pending requests on dispose with a stable cause', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);

    const bashPromise = interactions.requestBashApproval({
      command: 'echo hi',
      streamId: 'stream-a' as StreamTabId,
    });
    const planPromise = interactions.requestPlanApproval({
      approvalId: 'plan-a',
      streamId: 'stream-b' as StreamTabId,
      goalEnabled: false,
      plan: { objective: 'Prove the lemma.' },
    });

    interactions.dispose?.();

    await expect(bashPromise).resolves.toEqual({
      accepted: false,
      userMessage: 'Desktop presentation detached.',
    });
    await expect(planPromise).resolves.toEqual({
      action: 'reject',
      feedback: 'Desktop presentation detached.',
    });
    expect(handlers.transport.bash.dismiss).toHaveBeenCalled();
    expect(handlers.transport.planApproval.dismiss).toHaveBeenCalled();
  });
});
