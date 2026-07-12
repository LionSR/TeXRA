// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Suites for src/tools/wolfram (WolframTool approval gating +
// wolframScriptUtils argument handling).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals } from '@tools/approval';
import {
  wolframApprovalCommand,
  WolframTool,
} from '@tools/wolfram/WolframTool';
import * as wolframScriptUtils from '@tools/wolfram/wolframScriptUtils';
import {
  executeWolframCode,
  executeWolframScriptFile,
} from '@tools/wolfram/wolframScriptUtils';
import { createRecordingHost } from '../agent/progressTestUtils';
import { waitForRecordedEvent } from '../support/asyncTestUtils';
import { strict as assert } from 'node:assert';
import * as toolUtils from '@utils/system/toolUtils';
import * as execUtils from '@utils/system/execUtils';

// ---------------------------------------------------------------------------
// Wolfram
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// wolframScriptUtils
// ---------------------------------------------------------------------------

describe('wolframScriptUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'executeWolframCode delegates to runWolfram with code args',
      run: () => executeWolframCode('1+1'),
      stdout: '2',
      expectedArgs: ['wolframscript', '-code', '1+1'],
      expectedTimeout: 30000,
    },
    {
      name: 'executeWolframScriptFile delegates to runWolfram with file args',
      run: () => executeWolframScriptFile('/tmp/test.wls'),
      stdout: 'done',
      expectedArgs: ['wolframscript', '-file', '/tmp/test.wls'],
      expectedTimeout: 60000,
    },
  ])('$name', async ({ run, stdout, expectedArgs, expectedTimeout }) => {
    const calls: any[] = [];
    vi.spyOn(toolUtils, 'checkToolInstalled').mockResolvedValue(true);
    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      async (command, opts) => {
        calls.push(command, opts);
        return { success: true, stdout, stderr: '' } as any;
      },
    );

    const result = await run();

    assert.deepStrictEqual(calls[0], expectedArgs);
    assert.strictEqual(calls[1].timeout, expectedTimeout);
    assert.ok(result.success);
    assert.strictEqual(result.output, stdout);
  });
});
