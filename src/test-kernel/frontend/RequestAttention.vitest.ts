import { Effect, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { RequestAttention } from '@progressView/requestAttention';
import type { RunId } from '@shared/schemas';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';

const runId = 'run-1' as RunId;

function viewWith(requests: SessionView['requests']): SessionView {
  const view = emptySessionView('session');
  const run = { id: runId, approval: 'own', readOnly: false };
  return {
    ...view,
    runs: new Map([[runId, run as never]]),
    requests,
  };
}

describe('RequestAttention', () => {
  // Only tool edits used to bring a hidden view forward, so a command
  // approval (like a question or a retry) waited unseen and the run stalled.
  it('badges and reveals a command approval without taking focus', async () => {
    const sidebar = { badge: undefined as unknown, show: vi.fn() };
    const showSessions = vi.fn();
    const attention = new RequestAttention({
      sidebar: () => sidebar as never,
      panel: () => undefined,
      isViewVisible: () => false,
      showInSidebar: () => Effect.die('focus command must not run'),
      showSessions,
    });
    const bash = {
      runId,
      requestId: 'bash-1',
      payload: { kind: 'bash' } as never,
      thread: null,
    };

    await Effect.runPromise(
      attention.follow({
        viewChanges: Stream.make(viewWith([]), viewWith([bash])),
      }),
    );

    expect(sidebar.show).toHaveBeenCalledExactlyOnceWith(true);
    expect(showSessions).toHaveBeenCalledExactlyOnceWith(runId);
    expect(sidebar.badge).toMatchObject({ value: 1 });
  });
});
