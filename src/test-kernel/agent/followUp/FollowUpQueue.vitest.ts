import { describe, expect, it } from 'vitest';

import { FollowUpQueue } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

const stream = (value: string) => value as StreamTabId;

function liveFlowQueue(id: string) {
  const queues = new ToolUseFollowUpQueue();
  const streamId = stream(id);
  queues.claimLive(streamId, 'flow');
  return { queues, id: streamId };
}

function childResult(deliveryId: string) {
  return {
    text: 'child result',
    origin: 'subagent_result' as const,
    deliveryId,
  };
}

describe('FollowUpQueue', () => {
  const activeSignal = () => new AbortController().signal;

  it('keeps visible and synthetic batches separate', async () => {
    const queue = new FollowUpQueue();
    queue.enqueueSynthetic('compact');
    queue.enqueue({ text: 'first', mediaFiles: ['/tmp/a.png'] });
    queue.enqueue({ text: 'second', origin: 'subagent_result' });

    expect(queue.getAll()).toEqual(['first', 'second']);
    await expect(queue.waitAndDrainAll(activeSignal())).resolves.toEqual({
      items: [{ text: 'compact', origin: 'synthetic' }],
      synthetic: true,
    });
    await expect(queue.waitAndDrainAll(activeSignal())).resolves.toEqual({
      items: [
        { text: 'first', mediaFiles: ['/tmp/a.png'], origin: 'user' },
        { text: 'second', origin: 'subagent_result' },
      ],
      synthetic: false,
    });
  });

  it('rejects a second waiter instead of replacing the first', async () => {
    const queue = new FollowUpQueue();
    const first = queue.waitForNext(activeSignal());

    expect(() => queue.waitForNext(activeSignal())).toThrow(
      'already has a waiting consumer',
    );
    queue.enqueue({ text: 'accepted once' });
    await expect(first).resolves.toEqual({
      text: 'accepted once',
      origin: 'user',
    });
  });

  it('settles an active wait from the supplied run signal', async () => {
    const queue = new FollowUpQueue();
    const controller = new AbortController();
    const waiting = queue.waitForNext(controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBeNull();
  });
});

describe('ToolUseFollowUpQueue ownership', () => {
  it('allows exactly one live or recovery owner', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:exclusive');
    const child = queues.claimLive(id, 'child');
    expect(child).toBeDefined();
    expect(queues.claimLive(id, 'flow')).toBeUndefined();
    expect(queues.claimRecovery(id)).toBeUndefined();

    expect(queues.release(child!, 'recoverable')).toBe(true);
    const recovery = queues.claimRecovery(id);
    expect(recovery).toBeDefined();
    expect(queues.claimLive(id, 'child')).toBeUndefined();
  });

  it('does not let a stale lease release a successor generation', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:generation');
    const child = queues.claimLive(id, 'child')!;
    queues.queue(child).enqueue({ text: 'before handoff' });
    queues.release(child, 'recoverable');
    const recovery = queues.claimRecovery(id)!;
    expect(
      queues.submit(id, { text: 'during recovery' }, 'recoverable'),
    ).toEqual({ kind: 'recovering' });

    expect(queues.release(child, 'terminal')).toBe(false);
    expect(queues.getAll(id)).toEqual(['before handoff', 'during recovery']);
    expect(queues.drainItems(recovery).map((item) => item.text)).toEqual([
      'before handoff',
      'during recovery',
    ]);
  });

  it('enqueues live_owner notifications on a recoverable entry without claiming', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:live-notify');
    const child = queues.claimLive(id, 'child')!;
    queues.release(child, 'recoverable');

    // live_owner admission on a recoverable entry (no child owner) should
    // enqueue without claiming ownership, returning 'queued'.
    expect(queues.submit(id, { text: 'progress' }, 'live_owner')).toEqual({
      kind: 'queued',
    });
    expect(queues.getAll(id)).toEqual(['progress']);

    // The entry stays recoverable (no owner) — a subsequent recovery claim
    // can still acquire it.
    const recovery = queues.claimRecovery(id);
    expect(recovery).toBeDefined();
  });

  it('keeps sessions isolated for the same stream id', () => {
    const a = new ToolUseFollowUpQueue();
    const b = new ToolUseFollowUpQueue();
    const id = stream('stream:shared-id');
    const aLease = a.claimLive(id, 'flow')!;
    const bLease = b.claimLive(id, 'flow')!;

    a.queue(aLease).enqueue({ text: 'a' });
    b.queue(bLease).enqueue({ text: 'b' });

    expect(a.drainItems(aLease).map((item) => item.text)).toEqual(['a']);
    expect(b.drainItems(bLease).map((item) => item.text)).toEqual(['b']);
  });

  it('never reopens a terminal stream', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:terminal');
    const lease = queues.claimLive(id, 'flow')!;
    queues.release(lease, 'terminal');

    expect(queues.claimLive(id, 'flow')).toBeUndefined();
    expect(queues.submit(id, { text: 'late' }, 'recoverable')).toEqual({
      kind: 'unavailable',
    });
  });

  it('starts a new child generation for an authorized retry', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:retried-child');
    const first = queues.claimChildRun(id)!;
    queues.release(first, 'terminal');

    expect(queues.claimLive(id, 'flow')).toBeUndefined();
    expect(queues.submit(id, { text: 'late' }, 'live_owner')).toEqual({
      kind: 'unavailable',
    });

    const retry = queues.claimChildRun(id);
    expect(retry).toBeDefined();
    expect(retry?.kind).toBe('child');
    expect(retry?.generationId).not.toBe(first.generationId);
    expect(queues.hasLiveOwner(id)).toBe(true);
  });

  it('deletion invalidates a live generation and rejects late input', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:deleted');
    const lease = queues.claimLive(id, 'child')!;

    expect(queues.terminalize(id)).toBe(true);
    expect(queues.release(lease, 'recoverable')).toBe(false);
    expect(queues.submit(id, { text: 'late' }, 'recoverable')).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('ToolUseFollowUpQueue delivery identity (#9531)', () => {
  it('suppresses a replayed delivery id instead of appending it again', () => {
    const { queues, id } = liveFlowQueue('stream:replay');
    const delivery = childResult('exec-1:turn:1:delivery');

    expect(queues.submit(id, delivery, 'live_owner')).toEqual({
      kind: 'live_flow',
    });
    for (let replay = 0; replay < 100; replay++) {
      expect(queues.submit(id, delivery, 'live_owner')).toEqual({
        kind: 'duplicate',
      });
    }
    expect(queues.getAll(id)).toEqual(['child result']);
  });

  it('keeps distinct delivery ids distinct even with identical text', () => {
    const { queues, id } = liveFlowQueue('stream:distinct-deliveries');

    const first = queues.submit(
      id,
      { text: 'same text', origin: 'subagent_result', deliveryId: 'd1' },
      'live_owner',
    );
    const second = queues.submit(
      id,
      { text: 'same text', origin: 'subagent_result', deliveryId: 'd2' },
      'live_owner',
    );

    expect(first).toEqual({ kind: 'live_flow' });
    expect(second).toEqual({ kind: 'live_flow' });
    expect(queues.getAll(id)).toEqual(['same text', 'same text']);
  });

  it('keeps suppressing a replayed id across a recoverable release', () => {
    const queues = new ToolUseFollowUpQueue();
    const id = stream('stream:replay-across-release');
    const child = queues.claimLive(id, 'child')!;
    const delivery = childResult('d1');
    queues.submit(id, delivery, 'live_owner');
    queues.release(child, 'recoverable');

    expect(queues.submit(id, delivery, 'recoverable')).toEqual({
      kind: 'duplicate',
    });
    expect(queues.getAll(id)).toEqual(['child result']);
  });

  it('admits concurrent submissions of one delivery id at most once', () => {
    const { queues, id } = liveFlowQueue('stream:concurrent-replay');
    const delivery = childResult('d1');

    const outcomes = [
      queues.submit(id, delivery, 'live_owner'),
      queues.submit(id, delivery, 'live_owner'),
      queues.submit(id, delivery, 'live_owner'),
    ];

    expect(
      outcomes.filter((outcome) => outcome.kind === 'live_flow'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.kind === 'duplicate'),
    ).toHaveLength(2);
    expect(queues.getAll(id)).toEqual(['child result']);
  });

  it('never suppresses input that carries no delivery id', () => {
    const { queues, id } = liveFlowQueue('stream:no-delivery-id');

    queues.submit(id, { text: 'repeat me' }, 'live_owner');
    queues.submit(id, { text: 'repeat me' }, 'live_owner');

    expect(queues.getAll(id)).toEqual(['repeat me', 'repeat me']);
  });
});
