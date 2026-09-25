import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeTextStderrMock = vi.hoisted(() => vi.fn());

vi.mock('@cli/runtime/logSinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cli/runtime/logSinks')>();
  return {
    ...actual,
    writeTextStderr: writeTextStderrMock,
  };
});

import { warnApprovalDenied } from '@cli/runtime/approval/approvalPrompts';
import type { RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const EXECUTABLE = { kind: 'executable' } as const;

describe('warnApprovalDenied', () => {
  beforeEach(() => {
    writeTextStderrMock.mockClear();
    testDefaultSession().setApprovalPolicy('ask');
  });

  it('warns once per run and denial kind with the live policy', () => {
    testDefaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'never' });

    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE);
    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE);

    expect(writeTextStderrMock).toHaveBeenCalledTimes(1);
    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Command or edit denied: the approval policy is "never". Use --approval-policy yolo to allow it.',
    );

    // The chat TUI shares one context across overlapping runs (a detached
    // child outliving its root beside a new root): each run warns once, and
    // neither run's warning suppresses the other's.
    const [first, second] = ['a0000a', 'b0000b'] as RunId[];
    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE, first);
    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE, second);
    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE, first);
    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE, second);

    expect(writeTextStderrMock).toHaveBeenCalledTimes(3);
  });

  it('says what was closed and why a headless ask run could not prompt', () => {
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(testDefaultSession(), context, {
      kind: 'retry',
      deny: 'unpresentable',
    });

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Model error retry not attempted: no interactive prompt is available (approval policy "ask", headless run); a retry past the automatic attempts needs an interactive approval.',
    );
  });

  it('names the live session policy, not the launch-time CLI context', () => {
    // `/approval` in the TUI updates the session only; the frozen CliContext
    // keeps its launch-time value.
    testDefaultSession().setApprovalPolicy('never');
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(testDefaultSession(), context, EXECUTABLE);

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Command or edit denied: the approval policy is "never". Use --approval-policy yolo to allow it.',
    );
  });
});
