// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { StreamEventQueue } from '@eventBus/StreamEventQueue';

describe('StreamEventQueue', () => {
  it('serializes handlers for the same key', async () => {
    const queue = new StreamEventQueue();
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;

    const first = queue.enqueue('stream-a', () => {
      return new Promise<void>((resolve) => {
        resolveFirst = () => {
          order.push('first');
          resolve();
        };
      });
    });

    const second = queue.enqueue('stream-a', async () => {
      order.push('second');
    });

    await Promise.resolve();
    assert.deepEqual(order, []);

    resolveFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['first', 'second']);
  });

  it('does not block later handlers after a rejection', async () => {
    const queue = new StreamEventQueue();
    const order: string[] = [];

    await queue
      .enqueue('stream-b', async () => {
        throw new Error('boom');
      })
      .catch(() => undefined);

    await queue.enqueue('stream-b', async () => {
      order.push('second');
    });

    assert.deepEqual(order, ['second']);
  });

  it('cleans up queue entries after completion', async () => {
    const queue = new StreamEventQueue();

    await queue.enqueue('stream-c', async () => undefined);

    const queues = (queue as unknown as { queues: Map<string, Promise<void>> })
      .queues;
    assert.equal(queues.size, 0);
  });
});
