// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ToolUseSessionLifecycle } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import { FollowUpQueue } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

describe('FollowUpQueue', () => {
  function createLifecycle(streamId: StreamTabId): ToolUseSessionLifecycle {
    return new ToolUseSessionLifecycle(streamId, new ToolUseFollowUpQueue());
  }

  it('batches visible follow-ups for normal user input', async () => {
    const queue = new FollowUpQueue();

    queue.enqueue({ text: 'first' });
    queue.enqueue({ text: 'second' });

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [
        { text: 'first', origin: 'user' },
        { text: 'second', origin: 'user' },
      ],
      synthetic: false,
    });
  });

  it('keeps synthetic follow-ups out of visible queue state', async () => {
    const queue = new FollowUpQueue();

    queue.enqueueSynthetic('compact now');
    queue.enqueue({ text: 'user text' });

    expect(queue.getAll()).toEqual(['user text']);

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'compact now', origin: 'synthetic' }],
      synthetic: true,
    });
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'user text', origin: 'user' }],
      synthetic: false,
    });
  });

  it('coalesces a contiguous run of synthetic follow-ups into one batch', async () => {
    const queue = new FollowUpQueue();

    queue.enqueueSynthetic('maintenance one');
    queue.enqueueSynthetic('maintenance two');
    queue.enqueue({ text: 'user text' });

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [
        { text: 'maintenance one', origin: 'synthetic' },
        { text: 'maintenance two', origin: 'synthetic' },
      ],
      synthetic: true,
    });
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'user text', origin: 'user' }],
      synthetic: false,
    });
  });

  it('does not merge synthetic batches across a visible item', async () => {
    const queue = new FollowUpQueue();

    queue.enqueueSynthetic('maintenance one');
    queue.enqueue({ text: 'user text' });
    queue.enqueueSynthetic('maintenance two');

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'maintenance one', origin: 'synthetic' }],
      synthetic: true,
    });
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'user text', origin: 'user' }],
      synthetic: false,
    });
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [{ text: 'maintenance two', origin: 'synthetic' }],
      synthetic: true,
    });
  });

  it('carries media file paths on their own visible batch items', async () => {
    const queue = new FollowUpQueue();

    queue.enqueue({
      text: 'look at this',
      mediaFiles: ['/tmp/pasted/a.png'],
    });
    queue.enqueue({ text: 'and this', mediaFiles: ['/tmp/pasted/b.png'] });

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [
        {
          text: 'look at this',
          mediaFiles: ['/tmp/pasted/a.png'],
          origin: 'user',
        },
        {
          text: 'and this',
          mediaFiles: ['/tmp/pasted/b.png'],
          origin: 'user',
        },
      ],
      synthetic: false,
    });
  });

  it('keeps injected text separate from display text', async () => {
    const queue = new FollowUpQueue();

    queue.enqueue({
      text: '<skill_activation>hidden</skill_activation>',
      displayText: 'fix theorem',
    });

    expect(queue.getAll()).toEqual(['fix theorem']);
    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [
        {
          text: '<skill_activation>hidden</skill_activation>',
          displayText: 'fix theorem',
          origin: 'user',
        },
      ],
      synthetic: false,
    });
  });

  it('preserves subagent-result origin on queued delivery items', async () => {
    const queue = new FollowUpQueue();

    queue.enqueue({
      text: '<subagent-result>done</subagent-result>',
      origin: 'subagent_result',
    });
    queue.enqueue({ text: 'user correction' });

    await expect(queue.waitAndDrainAll(() => false)).resolves.toEqual({
      items: [
        {
          text: '<subagent-result>done</subagent-result>',
          origin: 'subagent_result',
        },
        { text: 'user correction', origin: 'user' },
      ],
      synthetic: false,
    });
  });

  it('coalesces duplicate synthetic session follow-ups', async () => {
    const session = createLifecycle('stream:synthetic-coalesce' as StreamTabId);

    try {
      session.appendSyntheticFollowUp('compact now');
      session.appendSyntheticFollowUp('compact again');

      await expect(session.waitForFollowUp(() => false)).resolves.toEqual({
        items: [{ text: 'compact now', origin: 'synthetic' }],
        synthetic: true,
      });
      expect(session.hasQueuedFollowUp()).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('allows synthetic session follow-ups after an interrupt clears the queue', async () => {
    const session = createLifecycle(
      'stream:synthetic-interrupt' as StreamTabId,
    );

    try {
      session.appendSyntheticFollowUp('compact before interrupt');
      session.interrupt();
      session.appendSyntheticFollowUp('compact after interrupt');

      await expect(session.waitForFollowUp(() => false)).resolves.toEqual({
        items: [{ text: 'compact after interrupt', origin: 'synthetic' }],
        synthetic: true,
      });
    } finally {
      session.dispose();
    }
  });

  it('attaches media to a session follow-up', async () => {
    const session = createLifecycle('stream:media-followup' as StreamTabId);

    try {
      session.appendFollowUp({
        text: 'describe the figure',
        mediaFiles: ['/tmp/pasted/fig.png'],
      });

      await expect(session.waitForFollowUp(() => false)).resolves.toEqual({
        items: [
          {
            text: 'describe the figure',
            mediaFiles: ['/tmp/pasted/fig.png'],
            origin: 'user',
          },
        ],
        synthetic: false,
      });
    } finally {
      session.dispose();
    }
  });

  it('does not create ghost queues for unknown streams', () => {
    const queue = new ToolUseFollowUpQueue();
    const streamId = 'stream:unknown-followup' as StreamTabId;

    try {
      expect(queue.enqueue(streamId, { text: 'late result' })).toBe(false);
      expect(queue.getAll(streamId)).toEqual([]);
    } finally {
      queue.release(streamId);
    }
  });

  it('creates queues only for explicitly admitted follow-ups', () => {
    const queue = new ToolUseFollowUpQueue();
    const streamId = 'stream:admitted-followup' as StreamTabId;

    try {
      expect(
        queue.enqueue(
          streamId,
          { text: 'admitted result' },
          { createIfMissing: true },
        ),
      ).toBe(true);
      expect(queue.getAll(streamId)).toEqual(['admitted result']);
    } finally {
      queue.release(streamId);
    }
  });

  it('does not forget every released stream when the release cap is exceeded', () => {
    const queue = new ToolUseFollowUpQueue();
    const firstStream = 'stream:released-first' as StreamTabId;
    const retainedStream = 'stream:released-retained' as StreamTabId;

    queue.acquire(firstStream);
    queue.release(firstStream);
    queue.acquire(retainedStream);
    queue.release(retainedStream);

    for (let i = 0; i < ToolUseFollowUpQueue.RELEASED_CAP - 1; i += 1) {
      queue.release(`stream:released-extra-${i}` as StreamTabId);
    }

    try {
      expect(queue.enqueue(firstStream, { text: 'late first' })).toBe(false);
      expect(queue.getAll(firstStream)).toEqual([]);
      expect(
        queue.enqueue(
          retainedStream,
          {
            text: 'late retained',
          },
          { createIfMissing: true },
        ),
      ).toBe(false);
      expect(queue.getAll(retainedStream)).toEqual([]);
    } finally {
      queue.release(firstStream);
      queue.release(retainedStream);
    }
  });
});
