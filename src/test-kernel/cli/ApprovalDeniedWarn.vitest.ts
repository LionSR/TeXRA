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
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const EXECUTABLE = { kind: 'executable', policy: 'never' } as const;

describe('warnApprovalDenied', () => {
  beforeEach(() => {
    writeTextStderrMock.mockClear();
  });

  it('warns once per run and denial kind with the deciding policy', () => {
    const context = createTestCliContext({ approvalPolicy: 'never' });

    warnApprovalDenied(context, EXECUTABLE);
    warnApprovalDenied(context, EXECUTABLE);

    expect(writeTextStderrMock).toHaveBeenCalledTimes(1);
    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Command or edit denied: the approval policy is "never". Change the project\'s approval policy (/config or the settings view) to allow it.',
    );

    // The chat TUI shares one context across overlapping runs (a detached
    // child outliving its root beside a new root): each run warns once, and
    // neither run's warning suppresses the other's.
    const [first, second] = ['a0000a', 'b0000b'] as RunId[];
    warnApprovalDenied(context, EXECUTABLE, first);
    warnApprovalDenied(context, EXECUTABLE, second);
    warnApprovalDenied(context, EXECUTABLE, first);
    warnApprovalDenied(context, EXECUTABLE, second);

    expect(writeTextStderrMock).toHaveBeenCalledTimes(3);
  });

  it('says what was closed and why a headless ask run could not prompt', () => {
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(context, {
      kind: 'retry',
      deny: 'unpresentable',
      policy: 'ask',
    });

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Model error retry not attempted: no interactive prompt is available (approval policy "ask", headless run); a retry past the automatic attempts needs an interactive approval.',
    );
  });

  it('names the policy that decided, not the launch-time CLI context', () => {
    // The frozen CliContext keeps its launch-time value after a `/approval`;
    // the denial carries the policy the session decided by.
    const context = createTestCliContext({ approvalPolicy: 'ask' });

    warnApprovalDenied(context, EXECUTABLE);

    expect(writeTextStderrMock).toHaveBeenCalledWith(
      '[warn] [cli-approval] Command or edit denied: the approval policy is "never". Change the project\'s approval policy (/config or the settings view) to allow it.',
    );
  });
});
