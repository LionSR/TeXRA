// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ToolUseSessionLifecycle } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import type { StreamTabId } from '@shared/schemas';

describe('FollowUpQueue', () => {
  it('batches visible follow-ups for normal user input', async () => {
    const queue = new FollowUpQueue();

    queue.enqueue('first');
    queue.enqueue('second');

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: ['first', 'second'],
      synthetic: false,
    });
  });

  it('keeps synthetic follow-ups out of visible queue state', async () => {
    const queue = new FollowUpQueue();

    queue.enqueueSynthetic('compact now');
    queue.enqueue('user text');

    expect(queue.getAll()).toEqual(['user text']);

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: ['compact now'],
      synthetic: true,
    });
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: ['user text'],
      synthetic: false,
    });
  });

  it('coalesces duplicate synthetic session follow-ups', async () => {
    const session = new ToolUseSessionLifecycle(
      'stream:synthetic-coalesce' as StreamTabId,
    );

    try {
      session.appendSyntheticFollowUp('compact now');
      session.appendSyntheticFollowUp('compact again');

      await expect(session.waitForFollowUp(() => false)).resolves.toEqual({
        items: ['compact now'],
        synthetic: true,
      });
      expect(session.hasQueuedFollowUp()).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('allows synthetic session follow-ups after an interrupt clears the queue', async () => {
    const session = new ToolUseSessionLifecycle(
      'stream:synthetic-interrupt' as StreamTabId,
    );

    try {
      session.appendSyntheticFollowUp('compact before interrupt');
      session.interrupt();
      session.appendSyntheticFollowUp('compact after interrupt');

      await expect(session.waitForFollowUp(() => false)).resolves.toEqual({
        items: ['compact after interrupt'],
        synthetic: true,
      });
    } finally {
      session.dispose();
    }
  });
});
