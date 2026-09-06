// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - TUI interaction policy
import {
  appDraftDiscardActive,
  approvalVisibleForSelection,
  digitFromMetaShortcut,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  triggerAppCtrlC,
  type AppCtrlCState,
  type ForegroundSurfaceKind,
} from '@cli/chat/tui/appInteractionPolicy';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import type { StreamTabId } from '@shared/schemas';

import { makeStreamView, viewWith } from './fixtures/sessionViewFixture';

type ForegroundSurfaceInput = Parameters<typeof foregroundSurfaceKind>[0];
type ForegroundEscapeInput = Parameters<typeof foregroundEscapeAction>[0];
type ForegroundRowsInput = Parameters<typeof foregroundMaxRowsForKind>[0];
type ApprovalKind = NonNullable<ForegroundRowsInput['approvalKind']>;
type MetaChordState = Parameters<
  typeof shouldDeferEscapeInterruptForMetaChord
>[0];

const escChordHidden = {
  shortcutModifierLabel: 'Esc',
  streamFocusAvailable: false,
} satisfies MetaChordState;

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

function bashApproval(streamId?: StreamTabId): PendingApproval {
  return {
    payload: {
      kind: 'bash',
      data: {
        requestId: 'bash-1',
        command: 'echo ok',
        allowBypass: true,
        streamId: streamId ?? '',
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

  it('does not let a background draft consume Ctrl+C', () => {
    const cases = [
      {
        inputDisabled: true,
        reverseSearchOpen: false,
        childListFocused: false,
      },
      {
        inputDisabled: false,
        reverseSearchOpen: true,
        childListFocused: false,
      },
      {
        inputDisabled: false,
        reverseSearchOpen: false,
        childListFocused: true,
      },
    ];

    for (const state of cases) {
      expect(appDraftDiscardActive(state)).toBe(false);
    }
    expect(
      appDraftDiscardActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        childListFocused: false,
      }),
    ).toBe(true);
  });

  it('resolves exhaustive foreground row caps', () => {
    const surfaceCases = [
      [{ kind: 'form' }, 18],
      [{ kind: 'infoPane' }, undefined],
      [{ kind: 'transcriptReader' }, undefined],
      [{ kind: 'workPlanReader' }, undefined],
    ] satisfies readonly (readonly [ForegroundRowsInput, number | undefined])[];
    const expectedByKind = {
      planApproval: undefined,
      retry: undefined,
      userQuestion: undefined,
      bash: 18,
      toolEdit: 18,
      proposal: 18,
      externalInquiry: 18,
    } satisfies Record<ApprovalKind, number | undefined>;

    for (const [input, expected] of surfaceCases) {
      expect(foregroundMaxRowsForKind(input)).toBe(expected);
    }
    for (const approvalKind of Object.keys(expectedByKind) as ApprovalKind[]) {
      expect(
        foregroundMaxRowsForKind({
          approvalKind,
          kind: 'approval',
        }),
      ).toBe(expectedByKind[approvalKind]);
    }
  });

  it('defers Escape interrupt whenever an Esc chord binding is visible', () => {
    const cases = [
      [{ ...escChordHidden, streamFocusAvailable: true }, true],
      [
        {
          ...escChordHidden,
          shortcutModifierLabel: 'Alt',
          streamFocusAvailable: true,
        },
        false,
      ],
      [escChordHidden, false],
    ] satisfies readonly (readonly [MetaChordState, boolean])[];

    for (const [state, expected] of cases) {
      expect(shouldDeferEscapeInterruptForMetaChord(state)).toBe(expected);
    }
  });

  it('parses stripped meta shortcut digits', () => {
    const cases = [
      ['1', 1],
      ['9', 9],
      ['0', undefined],
      ['10', undefined],
      ['p', undefined],
    ] satisfies readonly (readonly [string, number | undefined])[];

    for (const [value, expected] of cases) {
      expect(digitFromMetaShortcut(value)).toBe(expected);
    }
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
    const root = 'root' as StreamTabId;
    const child = 'child-1' as StreamTabId;
    const sibling = 'child-2' as StreamTabId;
    const ancestors = [{ id: root, label: 'root' }];
    const view = viewWith([
      makeStreamView({ id: root }),
      makeStreamView({ id: child, parentId: root, ancestors }),
      makeStreamView({ id: sibling, parentId: root, ancestors }),
    ]);
    const childApproval = bashApproval(child);
    const globalApproval = bashApproval();
    const visible = (selectedStreamId: StreamTabId, pending: PendingApproval) =>
      approvalVisibleForSelection({ pending, selectedStreamId, view });

    expect(visible(child, childApproval)).toBe(true);
    expect(visible(root, childApproval)).toBe(true);
    expect(visible(sibling, childApproval)).toBe(false);
    expect(visible(sibling, globalApproval)).toBe(true);
  });

  it('labels foreground escape actions from the owning surface', () => {
    const surfaceCases = [
      [{ foregroundKind: 'form' }, 'close'],
      [{ foregroundKind: 'infoPane' }, 'close'],
      [{ foregroundKind: 'transcriptReader' }, 'close'],
      [{ foregroundKind: 'workPlanReader' }, 'close'],
      [{ activeFormEscapeAction: 'cancel', foregroundKind: 'form' }, 'cancel'],
    ] satisfies readonly (readonly [ForegroundEscapeInput, string])[];
    const approvalCases = [
      ['externalInquiry', 'skip'],
      // Esc on an approval card rejects — the label names the consequence.
      ['bash', 'reject'],
      ['retry', 'give up'],
    ] satisfies readonly (readonly [ApprovalKind, string])[];

    for (const [input, expected] of surfaceCases) {
      expect(foregroundEscapeAction(input)).toBe(expected);
    }
    for (const [kind, expected] of approvalCases) {
      expect(
        foregroundEscapeAction({
          approvalKind: kind,
          foregroundKind: 'approval',
        }),
      ).toBe(expected);
    }
  });
});
