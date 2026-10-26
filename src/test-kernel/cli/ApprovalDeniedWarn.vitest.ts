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
});
