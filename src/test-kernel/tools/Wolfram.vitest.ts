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
  wolframRunSummary,
  WolframTool,
} from '@tools/wolfram/WolframTool';
import * as wolframScriptUtils from '@tools/wolfram/wolframScriptUtils';
import { executeWolframCode } from '@tools/wolfram/wolframScriptUtils';
import * as toolUtils from '@utils/system/toolUtils';
import * as execUtils from '@utils/system/execUtils';
import {
  createRecordingHost,
  sessionWithInteractions,
} from '../agent/progressTestUtils';
import { waitForRecordedEvent } from '../support/asyncTestUtils';

// ---------------------------------------------------------------------------
// Wolfram
// ---------------------------------------------------------------------------

async function dispatchWolfram(streamId: StreamTabId, code: string) {
  const explicit = createRecordingHost();
  const result = withRunContext(
    createRunContext({
      streamId,
      session: sessionWithInteractions(explicit.interactions),
    }),
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
      explicit.decisions.submitBash(show.payload.requestId, {
        action: 'approve',
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      output: '2',
      summary: 'Executed: 1+1',
    });
    expect(execute).toHaveBeenCalledWith('1+1', { timeout: 30000 });
  });

  it.each([
    {
      name: 'does not execute wolframscript when approval is rejected',
      feedback: 'Use the requested node check instead.',
      expectedInstruction: 'Use the requested node check instead.',
    },
    {
      name: 'tells the model not to retry after rejection without feedback',
      feedback: undefined,
      expectedInstruction: expect.stringContaining('Do not retry'),
    },
  ])('$name', async ({ feedback, expectedInstruction }) => {
    const execute = vi.spyOn(wolframScriptUtils, 'executeWolframCode');

    const { explicit, result, show } = await dispatchWolfram(
      'stream:wolfram-rejected' as StreamTabId,
      'Factor[n^7 - n]',
    );
    expect(
      explicit.decisions.submitBash(show.payload.requestId, {
        action: 'reject',
        ...(feedback === undefined ? {} : { feedback }),
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      status: 'error',
      userInstruction: expectedInstruction,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('wolframRunSummary', () => {
  it('embeds the first code line so concurrent calls render as distinct rows', () => {
    const a = wolframRunSummary('Print[Prime[10]]');
    const b = wolframRunSummary('Integrate[x^2, x]');
    expect(a).toBe('Executed: Print[Prime[10]]');
    expect(b).toBe('Executed: Integrate[x^2, x]');
    expect(a).not.toBe(b);
  });

  it('skips leading blank lines and uses the first meaningful line', () => {
    expect(wolframRunSummary('\n\n  Solve[x + 1 == 0, x]  \nPrint[x]')).toBe(
      'Executed: Solve[x + 1 == 0, x]',
    );
  });

  it('truncates a long first line with an ellipsis', () => {
    const long =
      'Table[Prime[k], {k, 1, 100}] (* a deliberately very long inline comment *)';
    const out = wolframRunSummary(long);
    expect(out.startsWith('Executed: ')).toBe(true);
    expect(out).toContain('…');
    // 'Executed: ' (10) + truncateWithEllipsis budget (60)
    expect(out.length).toBe('Executed: '.length + 60);
  });

  it.each(['', '   \n  \t '])(
    'falls back to plain "Executed" for blank code %j',
    (code) => {
      expect(wolframRunSummary(code)).toBe('Executed');
    },
  );
});

// ---------------------------------------------------------------------------
// wolframScriptUtils
// ---------------------------------------------------------------------------

describe('wolframScriptUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executeWolframCode runs wolframscript with code args', async () => {
    vi.spyOn(toolUtils, 'checkToolInstalled').mockResolvedValue(true);
    const executeCommand = vi
      .spyOn(execUtils, 'executeCommand')
      .mockResolvedValue({ success: true, stdout: '2', stderr: '' });

    const result = await executeWolframCode('1+1');

    expect(executeCommand).toHaveBeenCalledWith(
      ['wolframscript', '-code', '1+1'],
      expect.objectContaining({ timeout: 30000 }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('2');
  });
});
