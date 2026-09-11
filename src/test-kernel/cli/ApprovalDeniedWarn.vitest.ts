// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeTextStderrMock = vi.hoisted(() => vi.fn());

vi.mock('@cli/runtime/logSinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cli/runtime/logSinks')>();
  return {
    ...actual,
    writeTextStderr: writeTextStderrMock,
  };
});

import { defaultSession } from '@agent/runtime/SessionHandle';
import { warnApprovalDenied } from '@cli/runtime/approval/approvalPrompts';
import type { RunId } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

describe('warnApprovalDenied', () => {
  beforeEach(() => {
    writeTextStderrMock.mockClear();
    defaultSession().setApprovalPolicy('ask');
  });

  it('warns once per run with the gate and live policy', () => {
    defaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'never' });

    warnApprovalDenied(context, 'Tool or edit approval');
    warnApprovalDenied(context, 'Tool or edit approval');

    expect(writeTextStderrMock).toHaveBeenCalledTimes(1);
    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Tool or edit approval denied under policy "never".',
    );

    // The chat TUI shares one context across overlapping runs (a detached
    // child outliving its root beside a new root): each run warns once, and
    // neither run's warning suppresses the other's.
    const [first, second] = ['a0000a', 'b0000b'] as RunId[];
    warnApprovalDenied(context, 'Tool or edit approval', first);
    warnApprovalDenied(context, 'Tool or edit approval', second);
    warnApprovalDenied(context, 'Tool or edit approval', first);
    warnApprovalDenied(context, 'Tool or edit approval', second);

    expect(writeTextStderrMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to a generic gate label when none is given', () => {
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(context);

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Approval gate denied under policy "ask".',
    );
  });

  it('names the live session policy, not the launch-time CLI context', () => {
    // `/approval` in the TUI updates the session only; the frozen CliContext
    // keeps its launch-time value.
    defaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(context, 'Tool or edit approval');

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Tool or edit approval denied under policy "never".',
    );
  });
});
