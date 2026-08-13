// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - TUI interaction policy
import {
  appDraftDiscardActive,
  appEscapeInterruptActive,
  appFocusShortcutsActive,
  approvalVisibleForActiveStream,
  digitFromMetaShortcut,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  triggerAppCtrlC,
  triggerEscapeInterrupt,
  type AppCtrlCState,
  type EscapeInterruptState,
  type ForegroundSurfaceKind,
} from '@cli/chat/tui/appInteractionPolicy';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import type { StreamTabId } from '@shared/schemas';

type EscapeActiveState = Parameters<typeof appEscapeInterruptActive>[0];
type FocusState = Parameters<typeof appFocusShortcutsActive>[0];
type ForegroundSurfaceInput = Parameters<typeof foregroundSurfaceKind>[0];
type ForegroundEscapeInput = Parameters<typeof foregroundEscapeAction>[0];
type ForegroundRowsInput = Parameters<typeof foregroundMaxRowsForKind>[0];
type ApprovalKind = NonNullable<ForegroundRowsInput['approvalKind']>;
type MetaChordState = Parameters<
  typeof shouldDeferEscapeInterruptForMetaChord
>[0];

const focusEnabled = {
  foregroundOpen: false,
  reverseSearchOpen: false,
  slashPaletteOpen: false,
} satisfies FocusState;
const escapeInterruptEnabled = {
  inputDisabled: false,
  reverseSearchOpen: false,
  runPending: true,
  slashPaletteOpen: false,
} satisfies EscapeActiveState;
const escChordHidden = {
  shortcutModifierLabel: 'Esc',
  streamFocusAvailable: false,
} satisfies MetaChordState;

function ctrlCFixture({
  active,
  draft,
  delegate,
}: {
  readonly active: boolean;
  readonly draft: string;
  readonly delegate?: boolean;
}): {
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
      canStopActiveRun: () => active,
      onInterruptActive: () => events.push('interrupt'),
      onExit: () => events.push('exit'),
      onCtrlC: delegate ? () => events.push('delegate') : undefined,
    },
  };
}

function bashApproval(streamId?: StreamTabId): PendingApproval {
  return {
    payload: {
      kind: 'bash',
      payload: {
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
      scenario:
        'clears a non-empty draft without interrupting an active response',
      active: true,
      draft: 'unfinished',
      expected: 'clear-draft',
      events: ['clear'],
    },
    {
      scenario: 'clears a non-empty draft without exiting while idle',
      active: false,
      draft: 'unfinished',
      expected: 'clear-draft',
      events: ['clear'],
    },
    {
      scenario: 'interrupts an active response when the draft is empty',
      active: true,
      draft: '',
      expected: 'interrupt',
      events: ['interrupt'],
    },
    {
      scenario: 'exits an idle chat when the draft is empty',
      active: false,
      draft: '',
      expected: 'exit',
      events: ['exit'],
    },
  ])('$scenario', ({ active, draft, expected, events }) => {
    const fixture = ctrlCFixture({ active, draft });

    expect(triggerAppCtrlC(fixture.state)).toBe(expected);
    if (draft.length > 0) {
      expect(fixture.readDraft()).toBe('');
    }
    expect(fixture.events).toEqual(events);
  });

  it('delegates the second Ctrl+C after clearing to existing signal policy', () => {
    const fixture = ctrlCFixture({
      active: true,
      draft: 'unfinished',
      delegate: true,
    });

    expect(triggerAppCtrlC(fixture.state)).toBe('clear-draft');
    expect(triggerAppCtrlC(fixture.state)).toBe('delegate');
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

  it('lets input overlays own focus shortcuts', () => {
    const cases = [
      [focusEnabled, true],
      [{ ...focusEnabled, reverseSearchOpen: true }, false],
      [{ ...focusEnabled, slashPaletteOpen: true }, false],
      [{ ...focusEnabled, foregroundOpen: true }, false],
    ] satisfies readonly (readonly [FocusState, boolean])[];

    for (const [state, expected] of cases) {
      expect(appFocusShortcutsActive(state)).toBe(expected);
    }
  });

  it('only lets Escape interrupt when no foreground input owns it', () => {
    const cases = [
      [escapeInterruptEnabled, true],
      [{ ...escapeInterruptEnabled, runPending: false }, false],
      [{ ...escapeInterruptEnabled, inputDisabled: true }, false],
      [{ ...escapeInterruptEnabled, reverseSearchOpen: true }, false],
      [{ ...escapeInterruptEnabled, slashPaletteOpen: true }, false],
    ] satisfies readonly (readonly [EscapeActiveState, boolean])[];

    for (const [state, expected] of cases) {
      expect(appEscapeInterruptActive(state)).toBe(expected);
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

  it('runs Escape interrupt from the supplied current state', () => {
    const interrupted: StreamTabId[] = [];
    const target = 'focused-child' as StreamTabId;
    const baseState = {
      inputDisabled: false,
      reverseSearchOpen: false,
      slashPaletteOpen: false,
      onInterruptStream: (streamId: StreamTabId) => interrupted.push(streamId),
    } satisfies Omit<EscapeInterruptState, 'canInterruptStream'>;
    const cases = [
      [true, true, 1],
      [false, false, 1],
    ] satisfies readonly (readonly [boolean, boolean, number])[];

    for (const [canInterrupt, expected, expectedInterrupts] of cases) {
      expect(
        triggerEscapeInterrupt(
          {
            ...baseState,
            canInterruptStream: (streamId) =>
              streamId === target && canInterrupt,
          },
          target,
        ),
      ).toBe(expected);
      expect(interrupted).toHaveLength(expectedInterrupts);
    }
    expect(interrupted).toEqual([target]);
    expect(
      triggerEscapeInterrupt(
        {
          ...baseState,
          canInterruptStream: () => true,
        },
        undefined,
      ),
    ).toBe(false);
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

  it('shows stream-owned approvals only on their matching tab', () => {
    const childApproval = bashApproval('child-1');
    const globalApproval = bashApproval();
    const visible = (activeStreamId: StreamTabId, pending: PendingApproval) =>
      approvalVisibleForActiveStream({ activeStreamId, pending });

    expect(visible('child-1', childApproval)).toBe(true);
    expect(visible('root', childApproval)).toBe(false);
    expect(visible('root', globalApproval)).toBe(true);
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
