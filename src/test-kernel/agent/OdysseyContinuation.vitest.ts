// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FakeConfigProvider,
  createFakePlatform,
} from '@test/support/FakePlatform';
import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import type { StreamTabId } from '@shared/schemas';
import { ODYSSEY_FEATURE_FLAG_KEY, OdysseyStore } from '@tools/odyssey';
import type { Platform } from '@platform/platform';

const STREAM_ID = 'stream:odyssey-cont' as StreamTabId;

async function installPlatform(flagOn: boolean): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({
    config: flagOn ? { [ODYSSEY_FEATURE_FLAG_KEY]: true } : {},
  });
  initPlatform(platform);
  return platform;
}

describe('maybeBuildOdysseyContinuation', () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await installPlatform(true);
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

  it('returns null when the feature flag is off (with an active odyssey present)', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    // Flip just the flag — keep the same workspaceState so the active
    // odyssey is still on disk. Otherwise the test passes trivially.
    (platform.config as FakeConfigProvider).set(
      ODYSSEY_FEATURE_FLAG_KEY,
      false,
    );
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
    // Sanity: the record still exists; only the flag stopped the loop.
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('active');
  });

  it('returns null when no odyssey exists for the stream', async () => {
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it.each(['paused', 'complete', 'abandoned'] as const)(
    'returns null when the odyssey status is %s',
    async (status) => {
      await OdysseyStore.start(STREAM_ID, 'objective');
      await OdysseyStore.setStatus(STREAM_ID, status);
      const out = await maybeBuildOdysseyContinuation({
        streamId: STREAM_ID,
        isSubagent: false,
        hasQueuedFollowUp: false,
      });
      expect(out).toBeNull();
    },
  );

  it('auto-pauses when continuationCount reaches maxContinuations', async () => {
    const odyssey = await OdysseyStore.start(STREAM_ID, 'objective');
    // Drive the count up to the cap.
    for (let i = 0; i < odyssey.maxContinuations; i++) {
      await OdysseyStore.recordContinuation(STREAM_ID);
    }
    expect(OdysseyStore.getForStream(STREAM_ID)?.continuationCount).toBe(
      odyssey.maxContinuations,
    );

    // The next continuation attempt should pause the odyssey, not inject.
    const out = await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
    const after = OdysseyStore.getForStream(STREAM_ID);
    expect(after?.status).toBe('paused');
    expect(
      after?.history.some((e) => e.kind === 'continuation_cap_reached'),
    ).toBe(true);
  });

  it('resets continuationCount on resume so each leg gets a fresh budget', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    await OdysseyStore.recordContinuation(STREAM_ID);
    await OdysseyStore.recordContinuation(STREAM_ID);
    await OdysseyStore.setStatus(STREAM_ID, 'paused');
    await OdysseyStore.setStatus(STREAM_ID, 'active');
    expect(OdysseyStore.getForStream(STREAM_ID)?.continuationCount).toBe(0);
  });

  it('is a pure read — never records continuation_injected itself', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective');
    await maybeBuildOdysseyContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    const odyssey = OdysseyStore.getForStream(STREAM_ID);
    // The wait-node records the event ONLY on the committed branch
    // after re-checking hasQueuedFollowUp; the helper is pure.
    expect(
      odyssey?.history.some((e) => e.kind === 'continuation_injected'),
    ).toBe(false);
  });
});
