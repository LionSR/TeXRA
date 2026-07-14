// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import type { HostInteractionResolution } from '@agent/runtime/HostInteractions';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

// Local imports - desktop test paths
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
  resolve(requestId: string, result: HostInteractionResolution): boolean;
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
    getApprovalHandlers(): unknown;
    getToolEditApprovals(): {
      approvePendingForStream: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      requestApproval: ReturnType<typeof vi.fn>;
    };
  }): DesktopHostInteractions;
}

interface RecordingApprovalHandler {
  readonly show: ReturnType<typeof vi.fn>;
  readonly resolve: ReturnType<typeof vi.fn>;
}

function handler(): RecordingApprovalHandler {
  return { show: vi.fn(), resolve: vi.fn() };
}

function createHandlers() {
  return {
    toolEdit: handler(),
    bash: handler(),
    retry: handler(),
    agentProposal: handler(),
    planApproval: handler(),
    externalInquiry: handler(),
    userQuestion: handler(),
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
    approvePendingForStream: vi.fn(),
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

    await interactions.approvePendingDelegatedWork(
      'stream-a',
      'proposal-current',
    );

    await expect(parallel).resolves.toEqual({ action: 'approve' });
    await expect(bash).resolves.toEqual({
      accepted: true,
      userMessage: undefined,
    });
    expect(toolEditApprovals.approvePendingForStream).toHaveBeenCalledWith(
      'stream-a',
    );
    expect(handlers.agentProposal.resolve).toHaveBeenCalledWith(
      'proposal-parallel',
    );

    expect(
      interactions.resolve('proposal-current', {
        kind: 'proposal',
        action: 'approve',
      }),
    ).toBe(true);
    const streamBRequestId = (
      handlers.bash.show.mock.calls.find(
        ([request]) => request.streamId === 'stream-b',
      )?.[0] as { requestId?: string } | undefined
    )?.requestId;
    expect(streamBRequestId).toBeDefined();
    expect(
      interactions.resolve(streamBRequestId!, {
        kind: 'bash',
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

  it('rejects a resolution whose kind does not match the pending request', async () => {
    const handlers = createHandlers();
    const { interactions, runtimeHost, sessionEvents } =
      await createInteractions(handlers);

    const resultPromise = interactions.requestBashApproval({
      command: 'echo hi',
      streamId: 'stream-a' as StreamTabId,
    });
    const requestId = firstShowRequestId(handlers.bash.show);

    // A mismatched kind under the same requestId must not settle the
    // pending bash approval as a plan action would — matches the extension
    // host's discriminant check.
    expect(
      interactions.resolve(requestId, { kind: 'plan', action: 'approve' }),
    ).toBe(false);

    expect(
      interactions.resolve(requestId, { kind: 'bash', action: 'approve' }),
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
    expect(handlers.bash.resolve).toHaveBeenCalled();
    expect(toolEditApprovals.cancel).toHaveBeenCalledWith({
      streamId: 'stream-a',
      cause: 'Stream resources released.',
    });
  });

  it('can cancel synchronously while presenting a request', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);
    handlers.bash.show.mockImplementation(() => {
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
    const requestId = firstShowRequestId(handlers.bash.show);

    expect(
      interactions.resolve(requestId, { kind: 'bash', action: 'timeout' }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      timedOut: true,
    });
    expect(handlers.bash.resolve).toHaveBeenCalledWith(requestId);
  });

  it('whitelists only known proposal actions from a pass-through value', async () => {
    const handlers = createHandlers();
    const { interactions } = await createInteractions(handlers);

    const resultPromise = interactions.requestAgentProposal({
      proposalId: 'proposal-a',
      streamId: 'stream-a' as StreamTabId,
      agentCategory: 'toolUse',
      agent: 'demo-agent',
    });

    // An unrelated object shape smuggled through `value` (containing an
    // `action` that isn't a real ProposalResult action) must not be trusted
    // verbatim — it should fall back to the resolution's own `action`.
    expect(
      interactions.resolve('proposal-a', {
        kind: 'proposal',
        action: 'reject',
        value: { action: 'not-a-real-action', foo: 'bar' },
        feedback: 'Rejected via unrelated caller shape.',
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'reject',
      feedback: 'Rejected via unrelated caller shape.',
    });
    expect(handlers.agentProposal.resolve).toHaveBeenCalledWith('proposal-a');
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
      userMessage: 'Desktop session disposed.',
    });
    await expect(planPromise).resolves.toEqual({
      action: 'reject',
      feedback: 'Desktop session disposed.',
    });
    expect(handlers.bash.resolve).toHaveBeenCalled();
    expect(handlers.planApproval.resolve).toHaveBeenCalled();
  });
});
