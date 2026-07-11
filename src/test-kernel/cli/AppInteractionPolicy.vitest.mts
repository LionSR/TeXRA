// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - TUI interaction policy
import {
  appEscapeInterruptActive,
  appFocusShortcutsActive,
  approvalForegroundMaxRows,
  approvalVisibleForActiveStream,
  childControlForegroundMaxRows,
  digitFromMetaShortcut,
  foregroundEscapeAction,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  triggerEscapeInterrupt,
  type EscapeInterruptState,
  type ForegroundSurfaceKind,
} from '@cli/chat/tui/appInteractionPolicy';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import type { StreamTabId } from '@shared/schemas';

type ApprovalKind = PendingApproval['payload']['kind'];
type EscapeActiveState = Parameters<typeof appEscapeInterruptActive>[0];
type FocusState = Parameters<typeof appFocusShortcutsActive>[0];
type ForegroundSurfaceInput = Parameters<typeof foregroundSurfaceKind>[0];
type ForegroundEscapeInput = Parameters<typeof foregroundEscapeAction>[0];
type MetaChordState = Parameters<
  typeof shouldDeferEscapeInterruptForMetaChord
>[0];

const root = 'root' as StreamTabId;
const child = 'child-1' as StreamTabId;
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
  subagentControlsAvailable: false,
  taskControlsAvailable: false,
} satisfies MetaChordState;

function pendingApproval(
  kind: ApprovalKind,
  streamId?: StreamTabId,
): PendingApproval {
  return {
    payload: { kind, payload: { streamId } } as PendingApproval['payload'],
    decide: () => undefined,
  };
}

function foregroundInput(
  overrides: Partial<ForegroundSurfaceInput> = {},
): ForegroundSurfaceInput {
  return {
    activeFormOpen: false,
    pendingApproval: true,
    transcriptViewerOpen: false,
    ...overrides,
  };
}

describe('app interaction policy', () => {
  it('uses a smaller row cap for empty child-control pickers', () => {
    const cases = [
      [false, 6],
      [true, 12],
    ] satisfies readonly (readonly [boolean, number])[];

    for (const [hasItems, expected] of cases) {
      expect(childControlForegroundMaxRows({ hasItems })).toBe(expected);
    }
  });

  it('applies exhaustive approval row-cap policy', () => {
    const expectedByKind = {
      plan: undefined,
      retry: undefined,
      userQuestion: undefined,
      bash: 18,
      toolEdit: 18,
      proposal: 18,
      externalInquiry: 18,
    } satisfies Record<ApprovalKind, number | undefined>;

    for (const kind of Object.keys(expectedByKind) as ApprovalKind[]) {
      expect(approvalForegroundMaxRows(pendingApproval(kind))).toBe(
        expectedByKind[kind],
      );
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
      // #7496: an in-flight WAITING child still advertises Esc+s and needs the defer window.
      [{ ...escChordHidden, subagentControlsAvailable: true }, true],
      [{ ...escChordHidden, taskControlsAvailable: true }, true],
      [
        {
          ...escChordHidden,
          shortcutModifierLabel: 'Alt',
          subagentControlsAvailable: true,
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
    let interrupts = 0;
    const baseState = {
      inputDisabled: false,
      reverseSearchOpen: false,
      slashPaletteOpen: false,
      onInterruptActive: () => {
        interrupts += 1;
      },
    } satisfies Omit<EscapeInterruptState, 'canInterruptActiveRun'>;
    const cases = [
      [true, true, 1],
      [false, false, 1],
    ] satisfies readonly (readonly [boolean, boolean, number])[];

    for (const [canInterrupt, expected, expectedInterrupts] of cases) {
      expect(
        triggerEscapeInterrupt({
          ...baseState,
          canInterruptActiveRun: () => canInterrupt,
        }),
      ).toBe(expected);
      expect(interrupts).toBe(expectedInterrupts);
    }
  });

  it('prioritizes foreground surfaces ahead of approvals', () => {
    const cases = [
      [foregroundInput({ childControlMode: 'subagents' }), 'childControls'],
      [foregroundInput({ transcriptViewerOpen: true }), 'transcript'],
      [foregroundInput({ activeFormOpen: true }), 'form'],
      [foregroundInput(), 'approval'],
      [foregroundInput({ pendingApproval: false }), undefined],
    ] satisfies readonly (readonly [
      ForegroundSurfaceInput,
      ForegroundSurfaceKind | undefined,
    ])[];

    for (const [input, expected] of cases) {
      expect(foregroundSurfaceKind(input)).toBe(expected);
    }
  });

  it('shows stream-owned approvals only on their matching tab', () => {
    const childApproval = pendingApproval('bash', child);
    const globalApproval = pendingApproval('toolEdit');
    const visible = (activeStreamId: StreamTabId, pending: PendingApproval) =>
      approvalVisibleForActiveStream({ activeStreamId, pending });

    expect(visible(child, childApproval)).toBe(true);
    const hiddenApprovalVisible = visible(root, childApproval);
    expect(hiddenApprovalVisible).toBe(false);
    expect(visible(root, globalApproval)).toBe(true);
    expect(
      appFocusShortcutsActive({
        ...focusEnabled,
        foregroundOpen: hiddenApprovalVisible,
      }),
    ).toBe(true);
  });

  it('labels foreground escape actions from the owning surface', () => {
    const surfaceCases = [
      [
        { childControlEscapeAction: 'close', foregroundKind: 'childControls' },
        'close',
      ],
      [
        { childControlEscapeAction: 'back', foregroundKind: 'childControls' },
        'back',
      ],
      [{ foregroundKind: 'form' }, 'close'],
      [{ activeFormEscapeAction: 'cancel', foregroundKind: 'form' }, 'cancel'],
    ] satisfies readonly (readonly [
      Omit<ForegroundEscapeInput, 'pending'>,
      string,
    ])[];
    const approvalCases = [
      ['externalInquiry', 'skip'],
      ['bash', 'cancel'],
    ] satisfies readonly (readonly [ApprovalKind, string])[];

    for (const [input, expected] of surfaceCases) {
      expect(foregroundEscapeAction({ ...input, pending: undefined })).toBe(
        expected,
      );
    }
    for (const [kind, expected] of approvalCases) {
      expect(
        foregroundEscapeAction({
          foregroundKind: 'approval',
          pending: pendingApproval(kind),
        }),
      ).toBe(expected);
    }
  });
});
