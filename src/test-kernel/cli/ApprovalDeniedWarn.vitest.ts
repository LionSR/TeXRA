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
