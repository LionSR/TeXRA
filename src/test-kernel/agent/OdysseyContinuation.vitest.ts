// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { createFakePlatform } from '@test/support/FakePlatform';
import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import type { StreamTabId } from '@shared/schemas';
import { ODYSSEY_FEATURE_FLAG_KEY, OdysseyStore } from '@tools/odyssey';

const STREAM_ID = 'stream:odyssey-cont' as StreamTabId;

async function installPlatform(flagOn: boolean): Promise<void> {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform({
      config: flagOn ? { [ODYSSEY_FEATURE_FLAG_KEY]: true } : {},
    }),
  );
}

describe('maybeBuildOdysseyContinuation', () => {
  beforeEach(async () => {
    await installPlatform(true);
  });

  afterEach(async () => {
    await OdysseyStore.forget(STREAM_ID);
  });

  it('returns a rendered prompt when an active odyssey is present', async () => {
    await OdysseyStore.start(
      STREAM_ID,
      'Complete the refactor until pnpm test passes',
    );
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toMatch(/<odyssey_context>/);
    expect(out).toContain('Complete the refactor until pnpm test passes');
  });

  it('returns null in subagent mode (parent owns continuation)', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: true,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('returns null when user already queued a follow-up', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: true,
    });
    expect(out).toBeNull();
  });

  it('returns null when the feature flag is off', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    await installPlatform(false);
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('returns null when no odyssey exists for the stream', async () => {
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('returns null when the odyssey is paused / complete / abandoned', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    await OdysseyStore.setStatus(STREAM_ID, 'paused');
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('records a continuation_injected event on success', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    const odyssey = OdysseyStore.getForStream(STREAM_ID);
    expect(
      odyssey?.history.some((e) => e.kind === 'continuation_injected'),
    ).toBe(true);
  });
});
