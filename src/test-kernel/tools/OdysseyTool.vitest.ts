// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FakeConfigProvider,
  createFakePlatform,
} from '@test/support/FakePlatform';
import { FileInteractionState } from '@agent/core/AgentWorkspaceState';
import { withToolEnvironment } from '@agent/toolUse/ToolFileInteractionContext';
import type { StreamTabId } from '@shared/schemas';
import {
  ODYSSEY_FEATURE_FLAG_KEY,
  OdysseyStore,
  OdysseyTool,
} from '@tools/odyssey';

import { createRecordingHost } from '../agent/progressTestUtils';

import type { Platform } from '@platform/platform';

const STREAM_ID = 'stream:odyssey-test' as StreamTabId;

async function installPlatform(flagOn: boolean): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({
    config: flagOn ? { [ODYSSEY_FEATURE_FLAG_KEY]: true } : {},
  });
  initPlatform(platform);
  return platform;
}

async function callTool(
  tool: OdysseyTool,
  input: unknown,
): Promise<ReturnType<OdysseyTool['call']>> {
  const { host } = createRecordingHost();
  return withToolEnvironment(
    {
      run: {
        runtimeHost: host,
        streamId: STREAM_ID,
      },
      call: {
        tracker: new FileInteractionState(),
      },
    },
    () => tool.call(input),
  );
}

describe('OdysseyTool', () => {
  beforeEach(async () => {
    // Reset any prior store state — install a fresh platform per test.
    await installPlatform(true);
  });

  afterEach(async () => {
    await OdysseyStore.forget(STREAM_ID);
  });

  it('start → view → complete loops cleanly and stops the loop', async () => {
    const tool = new OdysseyTool();

    const started = await callTool(tool, {
      command: 'start',
      objective: 'Complete the refactor until pnpm test passes',
    });
    expect(started.isError).toBeFalsy();
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('active');

    const viewed = await callTool(tool, { command: 'view' });
    expect(viewed.isError).toBeFalsy();
    expect(viewed.output).toContain('Status: active');
    expect(viewed.output).toContain('Complete the refactor');

    const completed = await callTool(tool, {
      command: 'complete',
      reason: 'Ran pnpm test; all 142 tests pass.',
    });
    expect(completed.isError).toBeFalsy();
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('complete');
    expect(OdysseyStore.getForStream(STREAM_ID)?.completedReason).toContain(
      'all 142 tests pass',
    );
  });

  it('refuses to start a second odyssey while one is active', async () => {
    const tool = new OdysseyTool();
    await callTool(tool, { command: 'start', objective: 'objective A' });
    const second = await callTool(tool, {
      command: 'start',
      objective: 'objective B',
    });
    expect(second.isError).toBe(true);
    expect(second.error).toMatch(/already in progress/i);
  });

  it('pauses an active odyssey with a reason', async () => {
    const tool = new OdysseyTool();
    await callTool(tool, { command: 'start', objective: 'objective C' });
    const paused = await callTool(tool, {
      command: 'pause',
      reason: 'Need API credentials from the user.',
    });
    expect(paused.isError).toBeFalsy();
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('paused');
  });

  it('errors when the feature flag is off', async () => {
    await installPlatform(false);
    const tool = new OdysseyTool();
    const result = await callTool(tool, { command: 'view' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/disabled/i);
    // No record should be created.
    expect(OdysseyStore.getForStream(STREAM_ID)).toBeNull();
  });

  it('errors when start is invoked with no objective', async () => {
    const tool = new OdysseyTool();
    const result = await callTool(tool, { command: 'start' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/objective/i);
  });

  it('rejects whitespace-only objective on start', async () => {
    const tool = new OdysseyTool();
    const result = await callTool(tool, {
      command: 'start',
      objective: '   \n\t  ',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/whitespace/i);
  });

  it('rejects whitespace-only reason on pause', async () => {
    const tool = new OdysseyTool();
    await callTool(tool, { command: 'start', objective: 'objective' });
    const result = await callTool(tool, { command: 'pause', reason: '   ' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/whitespace/i);
  });

  it('refuses to complete an abandoned odyssey', async () => {
    const tool = new OdysseyTool();
    await callTool(tool, { command: 'start', objective: 'objective' });
    await OdysseyStore.setStatus(
      'stream:odyssey-test' as StreamTabId,
      'abandoned',
      'user abandoned',
    );
    const result = await callTool(tool, {
      command: 'complete',
      reason: 'I think I am done.',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/abandoned/i);
  });

  it('reacts to runtime flag toggles via FakeConfigProvider', async () => {
    const platform = await installPlatform(false);
    const tool = new OdysseyTool();

    const offResult = await callTool(tool, { command: 'view' });
    expect(offResult.isError).toBe(true);

    (platform.config as FakeConfigProvider).set(ODYSSEY_FEATURE_FLAG_KEY, true);
    const onResult = await callTool(tool, { command: 'view' });
    expect(onResult.isError).toBeFalsy();
  });
});
