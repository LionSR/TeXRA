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
import {
  hasCliApprovalDenied,
  markApprovalDenied,
} from '@cli/runtime/approval/approvalPrompts';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

describe('markApprovalDenied', () => {
  beforeEach(() => {
    writeTextStderrMock.mockClear();
    defaultSession().setApprovalPolicy('ask');
  });

  it('warns once with the gate and policy on first denial', () => {
    defaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'never' });

    markApprovalDenied(context, 'Tool or edit approval');
    markApprovalDenied(context, 'Tool or edit approval');

    expect(hasCliApprovalDenied(context)).toBe(true);
    expect(writeTextStderrMock).toHaveBeenCalledTimes(1);
    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Tool or edit approval denied under policy "never".',
    );
  });

  it('falls back to a generic gate label when none is given', () => {
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    markApprovalDenied(context);

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Approval gate denied under policy "ask".',
    );
  });

  it('names the live session policy, not the launch-time CLI context', () => {
    // `/approval` in the TUI updates the session only; the frozen CliContext
    // keeps its launch-time value.
    defaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    markApprovalDenied(context, 'Tool or edit approval');

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Tool or edit approval denied under policy "never".',
    );
  });
});
