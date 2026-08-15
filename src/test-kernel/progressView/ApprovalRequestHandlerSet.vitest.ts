import { describe, expect, it, vi } from 'vitest';

import { LitSessionRenderer } from '@controllers/progressView/backend/LitSessionRenderer';
import {
  buildApprovalRequestHandlerSet,
  cancelApprovalRequestHandlers,
  createProgressBackendUiConfig,
  replayApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  type AgentProposalPermission,
  type ProgressViewOutboundMessage,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

const proposal = {
  proposalId: 'proposal-1',
  streamId: 'stream-1',
  agentCategory: AgentCategory.ToolUse,
  agent: 'search',
  model: 'deepseekproT',
  instruction: 'Search for a reference.',
  memories: [],
} satisfies AgentProposalPermission;

function recordingHandlers(
  messages: ProgressViewOutboundMessage[],
  overrides: Parameters<typeof buildApprovalRequestHandlerSet>[0]['overrides'],
): ApprovalRequestHandlerSet {
  // Permission delivery is the only half of the renderer these handlers use;
  // its projection/snapshot/bridge collaborators are never reached.
  const unused = undefined as unknown as never;
  return buildApprovalRequestHandlerSet({
    renderer: new LitSessionRenderer(
      unused,
      unused,
      unused,
      unused,
      (message) => messages.push(message),
      () => true,
    ),
    canSend: () => true,
    overrides,
  });
}

/** A handler set whose only real member per kind is one spied method. */
function spyHandlerSet(
  method: string,
  spies: Record<string, ReturnType<typeof vi.fn>>,
): ApprovalRequestHandlerSet {
  return Object.fromEntries(
    Object.entries(spies).map(([kind, spy]) => [kind, { [method]: spy }]),
  ) as unknown as ApprovalRequestHandlerSet;
}

describe('ApprovalRequestHandlerSet helpers', () => {
  it('uses the built-in permission transport for agent proposals by default', () => {
    const messages: ProgressViewOutboundMessage[] = [];
    const handlers = recordingHandlers(messages, {
      retry: { show: vi.fn(), dismiss: vi.fn() },
    });

    handlers.proposal.show(proposal);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'show',
      permission: { kind: PERMISSION_KIND.PROPOSAL, data: proposal },
    });

    expect(handlers.proposal.dismiss(proposal.proposalId)).toBe(true);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'resolve',
      kind: PERMISSION_KIND.PROPOSAL,
      id: proposal.proposalId,
    });
  });

  it('uses an explicit agent proposal transport override when supplied', () => {
    const messages: ProgressViewOutboundMessage[] = [];
    const show = vi.fn();
    const dismiss = vi.fn();
    const handlers = recordingHandlers(messages, {
      retry: { show: vi.fn(), dismiss: vi.fn() },
      proposal: { show, dismiss },
    });

    handlers.proposal.show(proposal);
    expect(show).toHaveBeenCalledWith(proposal);
    expect(messages).toEqual([]);

    expect(handlers.proposal.dismiss(proposal.proposalId)).toBe(true);
    expect(dismiss).toHaveBeenCalledWith(proposal.proposalId);
    expect(messages).toEqual([]);
  });

  it('routes cancellation through the handler named by the interaction kind', () => {
    const cancellationScope = {};
    const request = { streamId: 'stream-1' };
    const cancelWhere = {
      bash: vi.fn(),
      planApproval: vi.fn(),
      proposal: vi.fn(),
      retry: vi.fn(),
      userQuestion: vi.fn(),
    };
    for (const cancel of Object.values(cancelWhere)) {
      cancel.mockImplementation((predicate, cause) => {
        expect(cause).toBe('Session closed.');
        return predicate(request, cancellationScope) ? 1 : 0;
      });
    }
    const handlers = spyHandlerSet('cancelWhere', cancelWhere);
    const kinds = [
      'bash',
      'planApproval',
      'proposal',
      'retry',
      'userQuestion',
    ] as const satisfies readonly (keyof typeof cancelWhere)[];

    for (const kind of kinds) {
      expect(
        cancelApprovalRequestHandlers(handlers, [kind], {
          kind,
          streamId: 'stream-1',
          cancellationScope,
          cause: 'Session closed.',
        }),
      ).toBe(1);
      expect(cancelWhere[kind]).toHaveBeenCalledOnce();
      for (const cancel of Object.values(cancelWhere)) cancel.mockClear();
    }

    cancelApprovalRequestHandlers(
      handlers,
      ['bash', 'planApproval', 'proposal', 'userQuestion'],
      { cause: 'Session closed.' },
    );
    expect(cancelWhere.retry).not.toHaveBeenCalled();
  });

  it('replays every pending prompt kind', async () => {
    const replayCalls = {
      toolEdit: vi.fn<() => void>(),
      bash: vi.fn<() => void>(),
      externalInquiry: vi.fn<() => void>(),
      retry: vi.fn<() => void>(),
      proposal: vi.fn<() => void>(),
      planApproval: vi.fn<() => void>(),
      userQuestion: vi.fn<() => void>(),
    } satisfies Record<
      keyof ApprovalRequestHandlerSet,
      ReturnType<typeof vi.fn>
    >;
    const handlers = spyHandlerSet('replay', replayCalls);

    await replayApprovalRequestHandlers(handlers);

    for (const replay of Object.values(replayCalls)) {
      expect(replay).toHaveBeenCalledTimes(1);
    }
  });

  it('checks every pending prompt kind for hasPendingPermissions', () => {
    const hasPendingCalls = {
      toolEdit: vi.fn(() => false),
      bash: vi.fn(() => false),
      externalInquiry: vi.fn(() => false),
      retry: vi.fn(() => false),
      proposal: vi.fn(() => false),
      planApproval: vi.fn(() => false),
      userQuestion: vi.fn(() => false),
    } satisfies Record<
      keyof ApprovalRequestHandlerSet,
      ReturnType<typeof vi.fn>
    >;
    const handlers = spyHandlerSet('hasPendingForStream', hasPendingCalls);

    const { hasPendingPermissions } = createProgressBackendUiConfig({
      handlers,
      renderer: {} as LitSessionRenderer,
      canSend: () => true,
    });

    expect(hasPendingPermissions('stream-1')).toBe(false);

    for (const hasPendingForStream of Object.values(hasPendingCalls)) {
      expect(hasPendingForStream).toHaveBeenCalledWith('stream-1');
    }
  });
});
