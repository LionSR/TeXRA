import { describe, expect, it, vi } from 'vitest';

import {
  cancelApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';

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
  it('routes cancellation through the handler named by the interaction kind', () => {
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
        return predicate(request) ? 1 : 0;
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
});
