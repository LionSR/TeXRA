// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';

// Local imports - tools
import { cleanupAllApprovals } from '@tools/approval';
import {
  WolframTool,
  wolframApprovalCommand,
} from '@tools/wolfram/WolframTool';
import * as wolframScriptUtils from '@tools/wolfram/wolframScriptUtils';

// Local imports - test helpers
import { createRecordingHost } from '../agent/progressTestUtils';
import { waitForRecordedEvent } from '../support/asyncTestUtils';

async function dispatchWolfram(streamId: StreamTabId, code: string) {
  const explicit = createRecordingHost();
  const result = withRunContext(
    createRunContext({ runtimeHost: explicit.host, streamId }),
    () => new WolframTool().call({ code }),
  );
  const show = await waitForRecordedEvent(
    explicit.events,
    'showBashPermission',
  );
  return { explicit, result, show };
}

describe('WolframTool approval', () => {
  afterEach(() => {
    cleanupAllApprovals();
    vi.restoreAllMocks();
  });

  it('requests bash-style approval before executing wolframscript', async () => {
    const streamId = 'stream:wolfram-approval' as StreamTabId;
    const execute = vi
      .spyOn(wolframScriptUtils, 'executeWolframCode')
      .mockResolvedValue({
        success: true,
        output: '2',
        error: '',
        timedOut: false,
        exitCode: 0,
      });

    const { explicit, result, show } = await dispatchWolfram(streamId, '1+1');
    expect(show.payload).toMatchObject({
      command: wolframApprovalCommand('1+1'),
      allowBypass: true,
      streamId,
    });

    expect(
      explicit.host.interactions?.resolve(show.payload.requestId, {
        kind: 'bash',
        action: 'approve',
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      output: '2',
      summary: 'Executed: 1+1',
    });
    expect(execute).toHaveBeenCalledWith('1+1', { timeout: 30000 });
  });

  it('does not execute wolframscript when approval is rejected', async () => {
    const streamId = 'stream:wolfram-rejected' as StreamTabId;
    const execute = vi.spyOn(wolframScriptUtils, 'executeWolframCode');

    const { explicit, result, show } = await dispatchWolfram(streamId, '2+2');
    expect(
      explicit.host.interactions?.resolve(show.payload.requestId, {
        kind: 'bash',
        action: 'reject',
        feedback: 'Use the requested node check instead.',
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      status: 'error',
      userInstruction: 'Use the requested node check instead.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('tells the model not to retry after rejection without feedback', async () => {
    const streamId = 'stream:wolfram-rejected-default' as StreamTabId;
    const execute = vi.spyOn(wolframScriptUtils, 'executeWolframCode');

    const { explicit, result, show } = await dispatchWolfram(
      streamId,
      'Factor[n^7 - n]',
    );
    expect(
      explicit.host.interactions?.resolve(show.payload.requestId, {
        kind: 'bash',
        action: 'reject',
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      status: 'error',
      userInstruction: expect.stringContaining('Do not retry'),
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
