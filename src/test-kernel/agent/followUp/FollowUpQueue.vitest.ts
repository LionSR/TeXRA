import { describe, expect, it } from 'vitest';

import { FollowUpQueue } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

const stream = (value: string) => value as StreamTabId;

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
