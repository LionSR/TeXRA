import { describe, expect, it, vi } from 'vitest';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  type BashSettlement,
  matchesCancelSelector,
  type HostInteractionOptions,
  HostInteractions,
  type HostPlanApprovalRequest,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type { ProgressHostInteractions } from '@controllers/progressView/backend/progressHostInteractions';
import { createDesktopHostInteractions } from '@desktop/main/desktopHostInteractions';
import { setOutputChannelFactory } from '@logger/logUtils';
import {
  AgentCategory,
  type AgentProposal,
  type AgentProposalPermission,
  type BashPermission,
  type ExternalInquiryPermission,
  type Plan,
  type PlanApprovalPermission,
  type RetryPermission,
  type StreamTabId,
  type ToolEditPermission,
  type UserQuestionPermission,
} from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { createTestSession } from '@test/support/sessionTestUtils';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

/**
 * Plan approval, proposal, and retry requests travel `session.interactions`
 * directly. First-wins resolution, replacement cancellation for duplicate
 * request ids, and per-stream cleanup are pinned here against a real production
 * port implementation (the desktop one; it has no VS Code import graph)
 * installed into a real `SessionHandle` slot.
 */

const streamId = 'stream:interactions-test' as StreamTabId;
const plan: Plan = { objective: 'Route approvals through the session port.' };
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the runtime boundary.',
  memories: [],
};

interface UiEvent {
  event: string;
  id: string;
}

function createHandlerSet(events: UiEvent[]): ApprovalRequestHandlerSet {
  const handler = <
    T extends { streamId: string },
    K extends keyof T,
    Result = never,
  >(
    kind: string,
    idField: K,
  ): ApprovalRequestHandler<T, K, Result> =>
    new ApprovalRequestHandler<T, K, Result>(
      idField,
      (item) =>
        events.push({ event: `show:${kind}`, id: String(item[idField]) }),
      (id) => events.push({ event: `dismiss:${kind}`, id }),
      () => true,
    );
  return {
    toolEdit: handler<ToolEditPermission, 'requestId'>('toolEdit', 'requestId'),
    bash: handler<BashPermission, 'requestId', BashSettlement>(
      'bash',
      'requestId',
    ),
    retry: handler<RetryPermission, 'streamId', RetryResult>(
      'retry',
      'streamId',
    ),
    proposal: handler<AgentProposalPermission, 'requestId', ProposalResult>(
      'proposal',
      'requestId',
    ),
    planApproval: handler<
      PlanApprovalPermission,
      'requestId',
      PlanApprovalResult
    >('planApproval', 'requestId'),
    externalInquiry: handler<ExternalInquiryPermission, 'requestId'>(
      'externalInquiry',
      'requestId',
    ),
    userQuestion: handler<
      UserQuestionPermission,
      'requestId',
      UserQuestionSettlement
    >('userQuestion', 'requestId'),
  };
}

function createPortSession(): {
  session: SessionHandle;
  uiEvents: UiEvent[];
  emitted: string[];
  setApprovalBypassState: ReturnType<typeof vi.fn>;
  interactions: ProgressHostInteractions;
} {
  const uiEvents: UiEvent[] = [];
  const emitted: string[] = [];
  const presentationSink: Required<Pick<HostInteractions, 'emit'>> = {
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  };
  const handlers = createHandlerSet(uiEvents);
  const session = createTestSession();
  const setApprovalBypassState = vi.fn();
  // Real controller with an inert host: tool-edit approvals are not exercised
  // by these tests, but the port contract requires a full controller.
  const toolEditApprovals = new ToolEditApprovalController({
    interactions: presentationSink,
    session,
    host: {
      stagePreview: async () => {
        throw new Error('tool-edit approvals are not exercised here');
      },
      relativeDisplayPath: (filePath) => filePath,
      revealApprovalSurface: async () => {},
      openBuildDisplay: async () => {},
      reportError: () => {},
    },
    showToolEditPermission: () => {},
    resolveToolEditPermission: () => {},
    detachCause: 'Test session detached.',
  });
  const interactions = createDesktopHostInteractions({
    interactions: presentationSink,
    session,
    setApprovalBypassState,
    showInfoMessage: vi.fn(),
    getApprovalHandlers: () => handlers,
    getToolEditApprovals: () => toolEditApprovals,
  });
  session.useHostInteractions(interactions);
  return {
    session,
    uiEvents,
    emitted,
    setApprovalBypassState,
    interactions,
  };
}

function createControllablePlanAdapter(
  options: { settleOnDispose?: boolean } = {},
) {
  const requests: HostPlanApprovalRequest[] = [];
  const pending = new Map<
    string,
    {
      readonly request: HostPlanApprovalRequest;
      readonly cancellationScope?: object;
      readonly settle: (result: PlanApprovalResult) => void;
    }
  >();
  const dispose = vi.fn(() => {
    if (options.settleOnDispose === false) return;
    for (const { settle } of pending.values()) settle({ action: 'reject' });
    pending.clear();
  });
  const interactions: HostInteractions = {
    requestPlanApproval(request, requestOptions?: HostInteractionOptions) {
      requests.push(request);
      return new Promise((settle) =>
        pending.set(request.requestId, {
          request,
          cancellationScope: requestOptions?.cancellationScope,
          settle,
        }),
      );
    },
    cancel(selector = {}) {
      for (const [requestId, entry] of pending) {
        if (
          !matchesCancelSelector(
            {
              kind: 'planApproval',
              streamId: entry.request.streamId,
              cancellationScope: entry.cancellationScope,
            },
            selector,
          )
        )
          continue;
        pending.delete(requestId);
        entry.settle({ action: 'reject' });
      }
    },
    dispose,
  };
  const submit = (requestId: string, decision: PlanApprovalResult): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    entry.settle(decision);
    return true;
  };
  return { interactions, requests, submit, dispose };
}

const diagnostic: GenericDiagnostic = {
  severity: 1,
  message: 'Check this step.',
  range: {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 4 },
  },
};

const criticism = {
  absolutePath: '/worktree/paper.tex',
  line: 3,
  message: 'Tighten this claim.',
  severity: 4,
  confidence: 5,
};

function requestPlan(
  session: SessionHandle,
  requestId: string,
  stream: StreamTabId = streamId,
): Promise<PlanApprovalResult> {
  return session.interactions.requestPlanApproval({
    requestId,
    streamId: stream,
    plan,
    goalEnabled: false,
  });
}

function requestProposal(
  session: SessionHandle,
  requestId: string,
): Promise<ProposalResult> {
  return session.interactions.requestAgentProposal({
    requestId,
    streamId,
    ...proposal,
  });
}

/** Routes appendLine output into a returned array; reset with `setOutputChannelFactory(null)`. */
function captureOutputLines(): string[] {
  const lines: string[] = [];
  setOutputChannelFactory(() => ({
    appendLine: (message: string) => lines.push(message),
  }));
  return lines;
}

describe('session.interactions immediate capabilities', () => {
  it('forwards approval bypass state through the desktop port', () => {
    const { interactions, setApprovalBypassState } = createPortSession();
    const update = {
      streamId,
      kind: 'toolEdit',
      bypassActive: true,
    } as const;

    interactions.setApprovalBypassState?.(update);

    expect(setApprovalBypassState).toHaveBeenCalledWith(update);
  });

  it('delegates immediate capabilities to the active adapter', async () => {
    const session = createTestSession();
    const diagnostics = [diagnostic];
    const readDiagnostics = vi.fn(async (_path: string) => diagnostics);
    const addCriticism = vi.fn((_input: typeof criticism) => ({
      accepted: true,
      resolvedPath: criticism.absolutePath,
    }));
    session.useHostInteractions({
      readDiagnostics,
      addCriticism,
      cancel: vi.fn(),
    });

    try {
      expect(
        await session.interactions.readDiagnostics?.(criticism.absolutePath),
      ).toBe(diagnostics);
      expect(session.interactions.addCriticism?.(criticism)).toEqual({
        accepted: true,
        resolvedPath: criticism.absolutePath,
      });

      expect(readDiagnostics).toHaveBeenCalledWith(criticism.absolutePath);
      expect(addCriticism).toHaveBeenCalledWith(criticism);
    } finally {
      session.dispose();
    }
  });

  it('does not expose or replay immediate capabilities while detached', () => {
    const session = createTestSession();
    const detach = session.useHostInteractions({
      readDiagnostics: vi.fn(async () => [diagnostic]),
      addCriticism: vi.fn(() => ({
        accepted: true,
        resolvedPath: criticism.absolutePath,
      })),
      cancel: vi.fn(),
    });
    detach();

    expect(session.interactions.readDiagnostics).toBeUndefined();
    expect(session.interactions.addCriticism).toBeUndefined();

    const readDiagnostics = vi.fn(async () => [diagnostic]);
    const addCriticism = vi.fn(() => ({
      accepted: true,
      resolvedPath: criticism.absolutePath,
    }));
    session.useHostInteractions({
      readDiagnostics,
      addCriticism,
      cancel: vi.fn(),
    });

    expect(readDiagnostics).not.toHaveBeenCalled();
    expect(addCriticism).not.toHaveBeenCalled();
    session.dispose();
  });

  it('replays only opted-in presentation notices once after reattachment', async () => {
    const session = createTestSession();
    const firstInfo = vi.fn();
    const firstEmit = vi.fn();
    const detach = session.useHostInteractions({
      emit: firstEmit,
      showInfoMessage: firstInfo,
      cancel: vi.fn(),
    });
    detach();

    session.interactions.showInfoMessage('attachment-scoped');
    session.interactions.emit('requestShowError', {
      message: 'attachment-scoped',
    });
    session.interactions.showInfoMessage('replay this', {
      replayWhenAttached: true,
    });
    session.interactions.emit(
      'requestShowError',
      { message: 'replay this error' },
      { replayWhenAttached: true },
    );

    const secondInfo = vi.fn();
    const secondEmit = vi.fn();
    const detachSecond = session.useHostInteractions({
      emit: secondEmit,
      showInfoMessage: secondInfo,
      cancel: vi.fn(),
    });
    expect(secondInfo).not.toHaveBeenCalled();
    expect(secondEmit).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(secondInfo).toHaveBeenCalledOnce();
    expect(secondInfo).toHaveBeenCalledWith('replay this');
    expect(secondEmit).toHaveBeenCalledOnce();
    expect(secondEmit).toHaveBeenCalledWith('requestShowError', {
      message: 'replay this error',
    });

    detachSecond();
    const thirdInfo = vi.fn();
    const thirdEmit = vi.fn();
    session.useHostInteractions({
      emit: thirdEmit,
      showInfoMessage: thirdInfo,
      cancel: vi.fn(),
    });
    await Promise.resolve();

    expect(thirdInfo).not.toHaveBeenCalled();
    expect(thirdEmit).not.toHaveBeenCalled();
    expect(firstInfo).not.toHaveBeenCalled();
    expect(firstEmit).not.toHaveBeenCalled();
    session.dispose();
  });

  it('leaves remaining notices queued when replay detaches the host', async () => {
    const session = createTestSession();
    session.interactions.showInfoMessage('first', {
      replayWhenAttached: true,
    });
    session.interactions.showInfoMessage('second', {
      replayWhenAttached: true,
    });

    const firstInfo = vi.fn();
    let detachFirst = (): void => undefined;
    detachFirst = session.useHostInteractions({
      showInfoMessage: (message) => {
        firstInfo(message);
        detachFirst();
      },
      cancel: vi.fn(),
    });
    await Promise.resolve();

    expect(firstInfo).toHaveBeenCalledOnce();
    expect(firstInfo).toHaveBeenCalledWith('first');

    const secondInfo = vi.fn();
    session.useHostInteractions({
      showInfoMessage: secondInfo,
      cancel: vi.fn(),
    });
    await Promise.resolve();

    expect(secondInfo).toHaveBeenCalledOnce();
    expect(secondInfo).toHaveBeenCalledWith('second');
    await Promise.resolve();
    expect(firstInfo).toHaveBeenCalledOnce();
    expect(secondInfo).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('reports a synchronously throwing live-host emit as not delivered', () => {
    // The live-host immediate-attachment branch must apply the same guard as
    // the queued replay path: a host adapter whose emit throws synchronously
    // (a desktop renderer post during teardown) must read as not delivered,
    // not escape as an arbitrary host exception (#10466).
    const session = createTestSession();
    session.useHostInteractions({
      emit: () => {
        throw new Error('renderer torn down mid-post');
      },
      cancel: vi.fn(),
    });

    expect(
      session.interactions.emit('requestShowError', { message: 'boom' }),
    ).toBe(false);
    session.dispose();
  });

  it('reports a synchronously throwing replayed emit through onReplayNotDelivered', async () => {
    // A host adapter whose emit throws synchronously (a desktop renderer
    // post during teardown) escapes the replay closure's promise chain; the
    // throw must land in the same not-delivered callback as a returned
    // `false` or a rejection, not vanish into the replay loop's warn-log
    // (#10398).
    const session = createTestSession();
    const onReplayScheduled = vi.fn();
    const onReplayDelivered = vi.fn();
    const onReplayNotDelivered = vi.fn();

    session.interactions.emit(
      'requestShowError',
      { message: 'queued before attach' },
      {
        replayWhenAttached: true,
        onReplayScheduled,
        onReplayDelivered,
        onReplayNotDelivered,
      },
    );
    expect(onReplayScheduled).toHaveBeenCalledOnce();

    const throwingHost: HostInteractions = {
      emit: () => {
        throw new Error('renderer torn down mid-post');
      },
      cancel: vi.fn(),
    };
    session.useHostInteractions(throwingHost);
    await Promise.resolve();
    await Promise.resolve();

    expect(onReplayDelivered).not.toHaveBeenCalled();
    expect(onReplayNotDelivered).toHaveBeenCalledOnce();
    expect(onReplayNotDelivered).toHaveBeenCalledWith(throwingHost);
    session.dispose();
  });

  it('does not queue an opted-in notice delivered to an attached presentation', () => {
    const session = createTestSession();
    const firstInfo = vi.fn();
    const firstEmit = vi.fn();
    const detach = session.useHostInteractions({
      emit: firstEmit,
      showInfoMessage: firstInfo,
      cancel: vi.fn(),
    });

    session.interactions.showInfoMessage('deliver now', {
      replayWhenAttached: true,
    });
    session.interactions.emit(
      'requestShowError',
      { message: 'deliver error now' },
      { replayWhenAttached: true },
    );
    expect(firstInfo).toHaveBeenCalledOnce();
    expect(firstEmit).toHaveBeenCalledOnce();

    detach();
    const secondInfo = vi.fn();
    const secondEmit = vi.fn();
    session.useHostInteractions({
      emit: secondEmit,
      showInfoMessage: secondInfo,
      cancel: vi.fn(),
    });
    expect(secondInfo).not.toHaveBeenCalled();
    expect(secondEmit).not.toHaveBeenCalled();
    session.dispose();
  });

  it('caps the unattached replay queue by dropping the oldest notices', async () => {
    const session = createTestSession();
    const QUEUED = 300; // past the 256 cap
    for (let n = 0; n < QUEUED; n += 1) {
      session.interactions.showInfoMessage(`notice-${n}`, {
        replayWhenAttached: true,
      });
    }

    const messages: string[] = [];
    session.useHostInteractions({
      showInfoMessage: (message) => {
        messages.push(message);
      },
      cancel: vi.fn(),
    });
    await Promise.resolve();

    expect(messages).toHaveLength(256);
    expect(messages.at(0)).toBe(`notice-${QUEUED - 256}`);
    expect(messages.at(-1)).toBe(`notice-${QUEUED - 1}`);
    session.dispose();
  });
});

describe('session.interactions request bookkeeping', () => {
  it('disposes an adapter offered after terminal slot disposal', () => {
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    session.interactions.dispose();
    session.useHostInteractions(adapter.interactions);

    expect(adapter.dispose).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('does not turn an unattached external inquiry into a parked approval', () => {
    const session = createTestSession();
    try {
      expect(
        session.interactions.openExternalInquiry({
          requestId: 'inquiry:unattached',
          threadId: 'inquiry:unattached',
          question: 'Can this notification be shown?',
          streamId,
          mode: 'new',
          allowBypass: false,
          sessionLinks: null,
          draft: null,
          transcript: null,
        }),
      ).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('disposes attachments even when cancellation throws', () => {
    const session = createTestSession();
    const dispose = vi.fn();
    session.useHostInteractions({
      cancel: () => {
        throw new Error('cancel failed');
      },
      dispose,
    });

    expect(() => session.interactions.dispose()).toThrow('cancel failed');
    expect(dispose).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('warns once when a request parks unattached, then redispatches it', async () => {
    const lines = captureOutputLines();
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    const parkWarnings = (): string[] =>
      lines.filter((line) => line.includes('No interaction host is attached'));
    try {
      const pending = requestPlan(session, 'approval:parked-warning');

      expect(parkWarnings()).toHaveLength(1);
      expect(parkWarnings()[0]).toContain('WARN');
      expect(parkWarnings()[0]).toContain('planApproval');
      expect(parkWarnings()[0]).toContain(streamId);

      // Parking stays load-bearing: a host attaching later still replays the
      // request exactly once (this is how a webview reload recovers a prompt).
      session.useHostInteractions(adapter.interactions);
      expect(adapter.requests).toHaveLength(1);
      expect(
        adapter.submit('approval:parked-warning', { action: 'approve' }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });
      expect(parkWarnings()).toHaveLength(1);
    } finally {
      session.dispose();
      setOutputChannelFactory(null);
    }
  });

  it('keeps a parked request pending when the diagnostic sink throws', async () => {
    setOutputChannelFactory(() => ({
      appendLine: () => {
        throw new Error('diagnostic sink failed');
      },
    }));
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    try {
      const pending = requestPlan(session, 'approval:throwing-warning').then(
        (result) => ({ status: 'resolved' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

      expect(session.interactions.pendingCount).toBe(1);
      session.useHostInteractions(adapter.interactions);
      expect(adapter.requests).toHaveLength(1);
      expect(
        adapter.submit('approval:throwing-warning', { action: 'approve' }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({
        status: 'resolved',
        result: { action: 'approve' },
      });
      expect(session.interactions.pendingCount).toBe(0);
    } finally {
      session.dispose();
      setOutputChannelFactory(null);
    }
  });

  it('settles against the documented minimal `{ cancel }` host', async () => {
    const session = createTestSession();
    session.useHostInteractions({ cancel: vi.fn() });
    try {
      await expect(
        requestPlan(session, 'approval:minimal-host'),
      ).resolves.toEqual({ action: 'reject' });
      expect(session.interactions.pendingCount).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('buffers a request made while no adapter is attached', async () => {
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    try {
      const pending = requestPlan(session, 'approval:unattached');
      expect(adapter.requests).toEqual([]);

      session.useHostInteractions(adapter.interactions);
      expect(adapter.requests).toHaveLength(1);
      expect(adapter.submit('approval:unattached', { action: 'approve' })).toBe(
        true,
      );
      await expect(pending).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('keeps a pending request across adapter detach and reattach', async () => {
    const lines = captureOutputLines();
    const session = createTestSession();
    const first = createControllablePlanAdapter();
    const second = createControllablePlanAdapter();
    const pendingCounts: number[] = [];
    session.interactions.onPendingCountChange((count) =>
      pendingCounts.push(count),
    );
    try {
      const detach = session.useHostInteractions(first.interactions);
      const pending = requestPlan(session, 'approval:reattach');
      detach();
      await Promise.resolve();
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(pendingCounts).toEqual([1]);
      expect(
        lines.filter((line) =>
          line.includes('No interaction host is attached'),
        ),
      ).toHaveLength(1);

      session.useHostInteractions(second.interactions);
      expect(second.requests).toHaveLength(1);
      expect(second.submit('approval:reattach', { action: 'approve' })).toBe(
        true,
      );
      await expect(pending).resolves.toEqual({ action: 'approve' });
      expect(pendingCounts).toEqual([1, 0]);
    } finally {
      session.dispose();
      setOutputChannelFactory(null);
    }
  });

  it('observes every response-bearing request until cancellation', async () => {
    const session = createTestSession();
    const pendingCounts: number[] = [];
    const stopObserving = session.interactions.onPendingCountChange((count) =>
      pendingCounts.push(count),
    );
    const requests = [
      session.interactions.requestToolEditApproval({
        path: 'paper.tex',
        originalContent: 'old',
        proposedContent: 'new',
        sourceTool: 'edit_file',
        streamId,
      }),
      session.interactions.requestBashApproval({
        command: 'lake build',
        streamId,
      }),
      requestPlan(session, 'approval:count'),
      requestProposal(session, 'proposal:count'),
      session.interactions.requestRetry({
        requestId: 'retry:count',
        streamId,
        operation: 'model request',
      }),
      session.interactions.askUserQuestion({
        requestId: 'question:count',
        streamId,
        allowBypass: false,
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      }),
    ];

    expect(session.interactions.pendingCount).toBe(6);
    expect(pendingCounts).toEqual([1]);

    session.interactions.cancel({ cause: 'Test complete.' });
    await Promise.all(requests);

    expect(session.interactions.pendingCount).toBe(0);
    expect(pendingCounts).toEqual([1, 0]);

    stopObserving();
    const ignored = requestPlan(session, 'approval:after-observer-dispose');
    session.interactions.cancel({ cause: 'Test cleanup.' });
    await ignored;
    expect(pendingCounts).toHaveLength(2);
    session.dispose();
  });

  it('drops ordinary one-way events emitted while no host is attached', async () => {
    const session = createTestSession();
    const emit = vi.fn();
    try {
      session.interactions.emit('requestOpenFile', {
        location: { kind: 'external', absolutePath: '/tmp/stale.pdf' },
        preserveFocus: false,
      });
      session.interactions.emit('requestEnsureProgressView', {});
      session.interactions.emit('showAgentConfigBanner', {
        agentName: 'proofreader',
      });

      session.useHostInteractions({ emit, cancel: vi.fn() });
      await Promise.resolve();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('reports replayable notices queued before host attach as not delivered', () => {
    const session = createTestSession();
    try {
      expect(
        session.interactions.emit(
          'showAgentConfigBanner',
          { agentName: 'ghost' },
          { replayWhenAttached: true },
        ),
      ).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('cancels each adapter presentation before a host handoff redispatches it', async () => {
    const session = createTestSession();
    const first = createControllablePlanAdapter();
    const second = createControllablePlanAdapter();
    try {
      session.useHostInteractions(first.interactions);
      const pending = requestPlan(session, 'approval:handoff');
      const detachSecond = session.useHostInteractions(second.interactions);

      expect(first.submit('approval:handoff', { action: 'reject' })).toBe(
        false,
      );
      expect(second.requests).toHaveLength(1);

      detachSecond();

      expect(second.submit('approval:handoff', { action: 'reject' })).toBe(
        false,
      );
      expect(first.requests).toHaveLength(2);
      expect(first.submit('approval:handoff', { action: 'approve' })).toBe(
        true,
      );
      await expect(pending).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('settles an explicit cancellation while unattached', async () => {
    const session = createTestSession();
    const pending = requestPlan(session, 'approval:cancel-unattached');

    session.interactions.cancel({ streamId, cause: 'Run ended.' });

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: 'Run ended.',
    });
    session.dispose();
  });

  it('preserves user-question cancellation cause while unattached', async () => {
    const session = createTestSession();
    const pending = session.interactions.askUserQuestion({
      requestId: 'question:cancel-unattached',
      questions: [
        {
          question: 'Which normalization should be used?',
          options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
        },
      ],
      allowBypass: false,
      streamId: '',
    });

    session.interactions.cancel({
      streamId: null,
      cause: 'No stream owns this question.',
    });

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: 'No stream owns this question.',
    });
    session.dispose();
  });

  it('settles buffered requests on terminal session disposal', async () => {
    const session = createTestSession();
    const pending = requestProposal(session, 'proposal:dispose-unattached');

    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: SESSION_DISPOSED_CAUSE,
    });
  });

  it('publishes the final pending boundary before disposal', async () => {
    const session = createTestSession();
    const adapter = createControllablePlanAdapter({ settleOnDispose: false });
    const pendingCounts: number[] = [];
    session.interactions.onPendingCountChange((count) =>
      pendingCounts.push(count),
    );
    session.useHostInteractions(adapter.interactions);
    const pending = requestPlan(session, 'approval:dispose-attached');

    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: SESSION_DISPOSED_CAUSE,
    });
    expect(pendingCounts).toEqual([1, 0]);
  });

  it('does not let a pending observer interrupt request cleanup', async () => {
    const session = createTestSession();
    session.interactions.onPendingCountChange(() => {
      throw new Error('title projection failed');
    });
    const pending = requestPlan(session, 'approval:throwing-observer');

    expect(session.interactions.pendingCount).toBe(1);
    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: SESSION_DISPOSED_CAUSE,
    });
  });

  it('resolves a plan approval first-wins through the session slot', async () => {
    const { session, uiEvents, emitted, interactions } = createPortSession();
    try {
      const pending = requestPlan(session, 'approval:first-wins');
      expect(pending).toBeDefined();
      // The port owns both the display and the activation emissions.
      expect(emitted).toContain('requestEnsureProgressView');
      expect(uiEvents).toContainEqual({
        event: 'show:planApproval',
        id: 'approval:first-wins',
      });

      expect(
        interactions.submitPlanDecision('approval:first-wins', {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });

      // First-wins: a second resolution finds nothing pending.
      expect(
        interactions.submitPlanDecision('approval:first-wins', {
          action: 'reject',
        }),
      ).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('rejects the stale request when the same id is re-requested (replacement)', async () => {
    const { session, uiEvents, interactions } = createPortSession();
    try {
      const first = requestPlan(session, 'approval:replace');
      const second = requestPlan(session, 'approval:replace');

      await expect(first).resolves.toMatchObject({ action: 'reject' });
      expect(
        uiEvents.filter((entry) => entry.event === 'show:planApproval'),
      ).toHaveLength(2);

      expect(
        interactions.submitPlanDecision('approval:replace', {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(second).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('a stream-scoped cancel settles every pending request for that stream only', async () => {
    const { session, interactions } = createPortSession();
    const otherStreamId = 'stream:interactions-other' as StreamTabId;
    try {
      const pendingPlan = requestPlan(session, 'approval:cleanup');
      const pendingProposal = requestProposal(session, 'proposal:cleanup');
      const surviving = requestPlan(
        session,
        'approval:survives',
        otherStreamId,
      );

      session.interactions.cancel({ streamId, cause: 'Run ended.' });

      await expect(pendingPlan).resolves.toMatchObject({ action: 'reject' });
      await expect(pendingProposal).resolves.toMatchObject({
        action: 'reject',
      });
      expect(
        interactions.submitPlanDecision('approval:cleanup', {
          action: 'approve',
        }),
      ).toBe(false);
      expect(
        interactions.submitProposalDecision('proposal:cleanup', {
          action: 'approve',
        }),
      ).toBe(false);

      // The other stream's request is untouched and still resolvable.
      expect(
        interactions.submitPlanDecision('approval:survives', {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(surviving).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('a kind-scoped cancel settles only that kind on the stream', async () => {
    const { session, interactions } = createPortSession();
    try {
      const pendingPlan = requestPlan(session, 'approval:kind-scope');
      const pendingProposal = requestProposal(session, 'proposal:kind-scope');

      session.interactions.cancel({
        streamId,
        kind: 'planApproval',
        cause: 'Plan approval cleared.',
      });

      await expect(pendingPlan).resolves.toMatchObject({ action: 'reject' });

      // The proposal on the same stream is untouched and still resolvable.
      expect(
        interactions.submitProposalDecision('proposal:kind-scope', {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pendingProposal).resolves.toMatchObject({
        action: 'approve',
      });
    } finally {
      session.dispose();
    }
  });

  it('session dispose settles whatever is still pending in the port', async () => {
    const { session } = createPortSession();
    const pending = requestProposal(session, 'proposal:dispose');

    session.dispose();

    await expect(pending).resolves.toMatchObject({ action: 'reject' });
  });
});
