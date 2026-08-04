// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    warn: warnMock,
  };
});

import {
  hasCliApprovalDenied,
  markApprovalDenied,
} from '@cli/runtime/approval/approvalPolicy';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

describe('markApprovalDenied', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it('warns once with the gate and policy on first denial', () => {
    const context = createTestCliContext({ approvalPolicy: 'never' });

    markApprovalDenied(context, 'Tool or edit approval');
    markApprovalDenied(context, 'Tool or edit approval');

    expect(hasCliApprovalDenied(context)).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      'cli-approval',
      'Tool or edit approval denied under policy "never".',
    );
  });

  it('falls back to a generic gate label when none is given', () => {
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    markApprovalDenied(context);

    expect(warnMock).toHaveBeenCalledWith(
      'cli-approval',
      'Approval gate denied under policy "ask".',
    );
  });
});
