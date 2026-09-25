// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - TUI interaction policy
import {
  approvalVisibleForSelection,
  foregroundSurfaceKind,
  type ForegroundSurfaceKind,
} from '@cli/chat/tui/appInteractionPolicy';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import type { RunId } from '@shared/schemas';

import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

type ForegroundSurfaceInput = Parameters<typeof foregroundSurfaceKind>[0];

function bashApproval(runId?: RunId): PendingApproval {
  return {
    payload: {
      kind: 'bash',
      data: {
        requestId: 'bash-1',
        command: 'echo ok',
        allowBypass: true,
        runId: runId ?? '',
      },
    },
    decide: () => undefined,
  };
}

function foregroundInput(
  overrides: Partial<ForegroundSurfaceInput> = {},
): ForegroundSurfaceInput {
  return {
    activeFormOpen: false,
    formBusy: false,
    infoPaneOpen: false,
    pendingApproval: true,
    readerOpen: false,
    ...overrides,
  };
}

describe('app interaction policy', () => {
  it('lets approvals preempt only a busy form', () => {
    const cases = [
      [foregroundInput({ activeFormOpen: true }), 'form'],
      [foregroundInput({ activeFormOpen: true, formBusy: true }), 'approval'],
      [foregroundInput({ infoPaneOpen: true }), 'approval'],
      [
        foregroundInput({ infoPaneOpen: true, pendingApproval: false }),
        'infoPane',
      ],
      [foregroundInput(), 'approval'],
      [foregroundInput({ pendingApproval: false }), undefined],
      // Readers are passive, so every surface that needs an answer takes the
      // foreground away from them.
      [foregroundInput({ pendingApproval: false, readerOpen: true }), 'reader'],
      [foregroundInput({ readerOpen: true }), 'approval'],
      [
        foregroundInput({
          activeFormOpen: true,
          pendingApproval: false,
          readerOpen: true,
        }),
        'form',
      ],
      [
        foregroundInput({
          infoPaneOpen: true,
          pendingApproval: false,
          readerOpen: true,
        }),
        'infoPane',
      ],
    ] satisfies readonly (readonly [
      ForegroundSurfaceInput,
      ForegroundSurfaceKind | undefined,
    ])[];

    for (const [input, expected] of cases) {
      expect(foregroundSurfaceKind(input)).toBe(expected);
    }
  });

  it('shows a stream-owned approval on its stream and its ancestors', () => {
    const root = 'root' as RunId;
    const child = 'child-1' as RunId;
    const sibling = 'child-2' as RunId;
    const ancestors = [{ id: root, label: 'root' }];
    const view = viewWith([
      makeRunView({ id: root }),
      makeRunView({ id: child, parentId: root, ancestors }),
      makeRunView({ id: sibling, parentId: root, ancestors }),
    ]);
    const childApproval = bashApproval(child);
    const globalApproval = bashApproval();
    const visible = (selectedRunId: RunId, pending: PendingApproval) =>
      approvalVisibleForSelection({ pending, selectedRunId, view });

    expect(visible(child, childApproval)).toBe(true);
    expect(visible(root, childApproval)).toBe(true);
    expect(visible(sibling, childApproval)).toBe(false);
    expect(visible(sibling, globalApproval)).toBe(true);
  });
});
