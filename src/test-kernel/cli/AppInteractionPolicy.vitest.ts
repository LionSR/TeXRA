// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - TUI interaction policy
import {
  approvalVisibleForSelection,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  triggerAppCtrlC,
  type AppCtrlCState,
  type ForegroundSurfaceKind,
} from '@cli/chat/tui/appInteractionPolicy';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import type { RunId } from '@shared/schemas';

import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

type ForegroundSurfaceInput = Parameters<typeof foregroundSurfaceKind>[0];
type ForegroundEscapeInput = Parameters<typeof foregroundEscapeAction>[0];
type ForegroundRowsInput = Parameters<typeof foregroundMaxRowsForKind>[0];
type ApprovalKind = NonNullable<ForegroundRowsInput['approvalKind']>;

function ctrlCFixture({ draft }: { readonly draft: string }): {
  readonly events: string[];
  readonly readDraft: () => string;
  readonly state: AppCtrlCState;
} {
  const events: string[] = [];
  let currentDraft = draft;
  return {
    events,
    readDraft: () => currentDraft,
    state: {
      discardDraft: () => {
        if (currentDraft.length === 0) return false;
        currentDraft = '';
        events.push('clear');
        return true;
      },
      onCtrlC: () => events.push('delegate'),
    },
  };
}

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
    readerKind: undefined,
    ...overrides,
  };
}

describe('app interaction policy', () => {
  it.each([
    {
      scenario: 'clears a non-empty draft instead of signalling the host',
      draft: 'unfinished',
      events: ['clear'],
    },
    {
      scenario: 'hands an empty-draft Ctrl+C to the host signal policy',
      draft: '',
      events: ['delegate'],
    },
  ])('$scenario', ({ draft, events }) => {
    const fixture = ctrlCFixture({ draft });

    triggerAppCtrlC(fixture.state);
    if (draft.length > 0) {
      expect(fixture.readDraft()).toBe('');
    }
    expect(fixture.events).toEqual(events);
  });

  it('delegates the second Ctrl+C after clearing to existing signal policy', () => {
    const fixture = ctrlCFixture({ draft: 'unfinished' });

    triggerAppCtrlC(fixture.state);
    triggerAppCtrlC(fixture.state);
    expect(fixture.events).toEqual(['clear', 'delegate']);
  });

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
      [
        foregroundInput({ pendingApproval: false, readerKind: 'transcript' }),
        'transcriptReader',
      ],
      [foregroundInput({ readerKind: 'transcript' }), 'approval'],
      [
        foregroundInput({ pendingApproval: false, readerKind: 'workPlan' }),
        'workPlanReader',
      ],
      [foregroundInput({ readerKind: 'workPlan' }), 'approval'],
      [
        foregroundInput({
          activeFormOpen: true,
          pendingApproval: false,
          readerKind: 'transcript',
        }),
        'form',
      ],
      [
        foregroundInput({
          infoPaneOpen: true,
          pendingApproval: false,
          readerKind: 'transcript',
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
