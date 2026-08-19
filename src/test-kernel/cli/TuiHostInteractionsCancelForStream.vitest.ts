// Regression coverage for #7306: a per-stream cancel must settle every
// approval kind on that stream, not only its retry routes.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

// Approval prompt preparation reads per-stream bypass state off the process
// session; stub the session so these queue-focused tests need no
// initializeDefaultSession/platform setup.
vi.mock('@agent/runtime/SessionHandle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/runtime/SessionHandle')>();
  const bypass = { isBypassed: () => false, setBypass: vi.fn() };
  const session = {
    approvalPolicy: 'ask',
    approvals: { bash: { bypass }, toolEdit: { bypass } },
    events: { emit: vi.fn() },
  };
  return {
    ...actual,
    currentSession: () => session,
    defaultSession: () => session,
  };
});

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { AgentCategory, type AgentProposal, type Plan } from '@shared/schemas';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';

function host(): CliRuntimeHost {
  return { emit: vi.fn() } as unknown as CliRuntimeHost;
}

/** Interactions bound to a fresh host, disposed when the test finishes. */
function tuiInteractions(): HostInteractions {
  const interactions = createTuiHostInteractions(host(), createTuiCliContext());
  onTestFinished(() => interactions.dispose?.());
  return interactions;
}

async function waitForApproval(
  kind: string,
  data: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, data });
  });
}

const plan: Plan = { objective: 'Ship the fix.' };
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the change.',
  memories: [],
};

afterEach(() => {
  clearApprovals();
});

describe('createTuiHostInteractions', () => {
  it('forwards presentation events to the attached CLI presenter', () => {
    const presentationHost = host();
    const interactions = createTuiHostInteractions(
      presentationHost,
      createTuiCliContext(),
    );
    onTestFinished(() => interactions.dispose?.());

    interactions.emit?.('requestShowError', { message: 'Run failed.' });

    expect(presentationHost.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'Run failed.',
    });
  });

  it('cancels a queued plan approval for the target stream, leaving other streams untouched', async () => {
    const interactions = tuiInteractions();
    const planResult = interactions.requestPlanApproval?.({
      requestId: 'approval-a',
      streamId: 'stream-a',
      plan,
      goalEnabled: false,
    });
    const otherStreamResult = interactions.requestPlanApproval?.({
      requestId: 'approval-b',
      streamId: 'stream-b',
      plan,
      goalEnabled: false,
    });

    await waitForApproval('planApproval', { streamId: 'stream-a' });

    interactions.cancel({ streamId: 'stream-a' });

    await expect(planResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });

    // stream-b's request was never touched and now becomes the foreground
    // modal instead of being left permanently pending.
    await waitForApproval('planApproval', { streamId: 'stream-b' });
    currentApproval.get()?.decide({ accepted: true });
    await expect(otherStreamResult).resolves.toEqual({ action: 'approve' });
  });

  it('settles plan decisions through the shared mapper: goal action kept, silent rejection omits feedback', async () => {
    const interactions = tuiInteractions();
    const goalResult = interactions.requestPlanApproval?.({
      requestId: 'approval-goal',
      streamId: 'stream-a',
      plan,
      goalEnabled: true,
    });
    await waitForApproval('planApproval', { streamId: 'stream-a' });
    currentApproval.get()?.decide({
      accepted: true,
      planAction: 'approve_and_goal',
    });
    await expect(goalResult).resolves.toEqual({
      action: 'approve_and_goal',
    });

    const rejected = interactions.requestPlanApproval?.({
      requestId: 'approval-reject',
      streamId: 'stream-a',
      plan,
      goalEnabled: false,
    });
    await waitForApproval('planApproval', { streamId: 'stream-a' });
    currentApproval.get()?.decide({ accepted: false });

    // A rejection without a user message omits `feedback` rather than
    // sending an explicit `undefined`.
    await expect(rejected).resolves.toStrictEqual({ action: 'reject' });
  });

  it('cancels a queued agent proposal for the target stream', async () => {
    const interactions = tuiInteractions();
    const proposalResult = interactions.requestAgentProposal?.({
      requestId: 'proposal-a',
      streamId: 'stream-a',
      ...proposal,
    });

    await waitForApproval('proposal', { streamId: 'stream-a' });

    interactions.cancel({ streamId: 'stream-a' });

    await expect(proposalResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('cancels a queued bash approval for the target stream (not just retry)', async () => {
    const interactions = tuiInteractions();
    const bashResult = interactions.requestBashApproval?.({
      command: 'echo hi',
      streamId: 'stream-a',
    });

    await waitForApproval('bash', { streamId: 'stream-a' });

    interactions.cancel({ streamId: 'stream-a' });

    await expect(bashResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('keeps queued tool-edit cancellation separate from user feedback', async () => {
    const interactions = tuiInteractions();
    const editResult = interactions.requestToolEditApproval?.({
      path: '/work/paper.tex',
      originalContent: 'old',
      proposedContent: 'new',
      sourceTool: 'edit',
      streamId: 'stream-a',
    });

    await waitForApproval('toolEdit', { streamId: 'stream-a' });
    interactions.cancel({ streamId: 'stream-a' });

    await expect(editResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('an unfiltered cancel settles a live retry', async () => {
    const interactions = tuiInteractions();
    // requestRetry holds a queue reservation from before the modal appears
    // until its decision has been acted on; cancel({}) must settle that
    // entry, resolving the pending retry with 'cancel'.
    const retryResult = interactions.requestRetry?.({
      requestId: 'retry:first',
      streamId: 'stream-a',
      operation: 'Model invocation',
    });

    await waitForApproval('retry', { streamId: 'stream-a' });

    interactions.cancel({ cause: 'All approvals cleared.' });

    await expect(retryResult).resolves.toEqual({ action: 'cancel' });
    expect(currentApproval.get()).toBeUndefined();

    // The settled entry is gone from the queue: a stale decision cannot
    // resurrect it, and a fresh request reserves a fresh entry.
    const second = interactions.requestRetry?.({
      requestId: 'retry:second',
      streamId: 'stream-a',
      operation: 'Model invocation',
    });
    await waitForApproval('retry', {});
    interactions.cancel({ streamId: 'stream-a', kind: 'retry' });
    await expect(second).resolves.toEqual({ action: 'cancel' });
  });

  it('a retry-kind cancel leaves a queued plan approval on the same stream pending', async () => {
    const interactions = tuiInteractions();
    const planResult = interactions.requestPlanApproval?.({
      requestId: 'approval-kind',
      streamId: 'stream-a',
      plan,
      goalEnabled: false,
    });

    await waitForApproval('planApproval', { streamId: 'stream-a' });

    interactions.cancel({ streamId: 'stream-a', kind: 'retry' });

    // The plan approval is still the foreground modal and still decidable.
    expect(currentApproval.get()?.payload).toMatchObject({
      kind: 'planApproval',
      data: { streamId: 'stream-a' },
    });
    currentApproval.get()?.decide({ accepted: true });
    await expect(planResult).resolves.toEqual({ action: 'approve' });
  });
});
