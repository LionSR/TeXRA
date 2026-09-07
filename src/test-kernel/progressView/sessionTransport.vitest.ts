// Third-party imports
import { expect, it, vi } from 'vitest';

// Local imports - transport boundary
import { installWebviewTransport } from '@progressView/frontend/sessionTransport';
import { aggregateId, AgentCategory } from '@shared/schemas';
import type { EventsFrame, UpMessage } from '@shared/session/sessionFrames';

const posted = vi.hoisted(() => [] as UpMessage[]);
vi.mock('@shared/hostBridge', () => ({
  hostBridge: { postMessage: (message: UpMessage) => posted.push(message) },
}));

it('recovers an incomplete replay from the published cursor and preserves pending requests', async () => {
  const transport = installWebviewTransport();
  const failure = vi.fn();
  transport.onReaderFailure(failure);
  const session = transport.open('paper');
  const id = aggregateId('stream', 'run');
  const frame: EventsFrame = {
    kind: 'events',
    session: 'paper',
    generation: 1,
    sequence: 1,
    cursor: 10,
    events: [
      {
        _tag: 'event',
        read: 'listing',
        event: {
          type: 'run.start',
          aggregateId: id,
          executionId: 'ab12cd',
          identity: { kind: 'agent', agent: 'chat' },
          category: AgentCategory.ToolUse,
          userFollowUpSupport: 'unsupported',
          isRemote: false,
          ownerId: null,
          at: 1,
          seq: 1,
          commit: 10,
        },
      },
    ],
    chunks: [],
    local: null,
    host: null,
    replayComplete: false,
  };
  try {
    transport.subscribe(session, [{ id, fromSeq: 0 }]);
    const pending = transport.request({
      kind: 'host.request',
      session: 'paper',
      requestId: 'pending',
      request: { kind: 'openFile', path: 'paper.tex' },
    });
    transport.receive(frame);
    await vi.waitFor(() =>
      expect(posted.some((message) => message.kind === 'reader.progress')).toBe(
        true,
      ),
    );
    expect(session.view$.get().cursor).toBe(0);
    transport.receive({ ...frame, sequence: 3 });
    expect(
      posted.findLast((message) => message.kind === 'subscribe'),
    ).toMatchObject({
      generation: 2,
      cursor: 0,
      aggregates: [{ id, fromSeq: 0 }],
    });
    transport.receive({ ...frame, generation: 2, replayComplete: true });
    await vi.waitFor(() => expect(session.view$.get().cursor).toBe(10));
    expect(session.view$.get().streams.has('run')).toBe(true);
    transport.receive({ ...frame, sequence: 4, replayComplete: true });
    expect(session.generation).toBe(2);
    // One failed retry reaches the existing surface error path, without a loop.
    transport.receive({
      kind: 'reader.error',
      session: 'paper',
      generation: 2,
      reason: 'Delivery failed',
      retryable: true,
    });
    expect(failure).toHaveBeenCalledWith('paper', 'Delivery failed');
    expect(session.generation).toBe(2);
    transport.receive({
      kind: 'response',
      session: 'paper',
      requestId: 'pending',
      result: { ok: true, outcome: { kind: 'done' } },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      outcome: { kind: 'done' },
    });
  } finally {
    transport.dispose();
  }
});
