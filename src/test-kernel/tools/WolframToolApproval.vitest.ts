// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';

// Local imports - tools
import { cleanupAllApprovals } from '@tools/approval';
import { handleProgressViewBashApprovalAction } from '@tools/approval/bashApproval';
import {
  WolframTool,
  wolframApprovalCommand,
} from '@tools/wolfram/WolframTool';
import * as wolframScriptUtils from '@tools/wolfram/wolframScriptUtils';

// Local imports - test helpers
import { createRecordingHost } from '../agent/progressTestUtils';
import { waitForRecordedEvent } from '../support/asyncTestUtils';

describe('WolframTool approval', () => {
  afterEach(() => {
    cleanupAllApprovals();
    vi.restoreAllMocks();
  });

  it('requests bash-style approval before executing wolframscript', async () => {
    const explicit = createRecordingHost();
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

    const result = withRunContext(
      createRunContext({ runtimeHost: explicit.host, streamId }),
      () => new WolframTool().call({ code: '1+1' }),
    );

    const show = await waitForRecordedEvent(
      explicit.events,
      'showBashPermission',
    );
    expect(show.payload).toMatchObject({
      command: wolframApprovalCommand('1+1'),
      allowBypass: true,
      streamId,
    });

    await handleProgressViewBashApprovalAction({
      requestId: show.payload.requestId,
      action: 'approve',
    });

    await expect(result).resolves.toMatchObject({
      output: '2',
      summary: 'Executed: 1+1',
    });
    expect(execute).toHaveBeenCalledWith('1+1', { timeout: 30000 });
  });

  it('does not execute wolframscript when approval is rejected', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:wolfram-rejected' as StreamTabId;
    const execute = vi.spyOn(wolframScriptUtils, 'executeWolframCode');

    const result = withRunContext(
      createRunContext({ runtimeHost: explicit.host, streamId }),
      () => new WolframTool().call({ code: '2+2' }),
    );

    const show = await waitForRecordedEvent(
      explicit.events,
      'showBashPermission',
    );
    await handleProgressViewBashApprovalAction({
      requestId: show.payload.requestId,
      action: 'reject',
      feedback: 'Use the requested node check instead.',
    });

    await expect(result).resolves.toMatchObject({
      isError: true,
      userInstruction: 'Use the requested node check instead.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('tells the model not to retry after rejection without feedback', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:wolfram-rejected-default' as StreamTabId;
    const execute = vi.spyOn(wolframScriptUtils, 'executeWolframCode');

    const result = withRunContext(
      createRunContext({ runtimeHost: explicit.host, streamId }),
      () => new WolframTool().call({ code: 'Factor[n^7 - n]' }),
    );

    const show = await waitForRecordedEvent(
      explicit.events,
      'showBashPermission',
    );
    await handleProgressViewBashApprovalAction({
      requestId: show.payload.requestId,
      action: 'reject',
    });

    await expect(result).resolves.toMatchObject({
      isError: true,
      userInstruction: expect.stringContaining('Do not retry'),
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
