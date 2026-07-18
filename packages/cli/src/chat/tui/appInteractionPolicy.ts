/** Pure foreground-surface and keyboard interaction policy for the root TUI. */

// Local imports - shared schemas and utilities
import type { StreamTabId } from '@shared/schemas';
import { assertNever } from '@utils/core';

// Local imports - TUI state
import {
  approvalPayloadStreamId,
  type PendingApproval,
} from './state/approvalQueue';

const TASK_DETAIL_FOREGROUND_MAX_ROWS = 12;
const FORM_FOREGROUND_MAX_ROWS = 18;
// Match form sizing for approval modals that already budget or scroll their
// content. Natural-height approvals stay uncapped until they grow row budgets.
const APPROVAL_FOREGROUND_MAX_ROWS = 18;
type ApprovalKind = PendingApproval['payload']['kind'];

// A bare Esc and the second key of an `Esc 1..9` chord are two
// separate keystrokes on terminals without true Meta-key detection (macOS
// Terminal.app). 125ms was too tight for a deliberate but unhurried chord
// (issue #7496: a ~400ms pause after Esc fired the bare-Esc
// interrupt and stopped a suspended WAITING subagent); widen to a
// tmux-style chord window so a human-paced chord still resolves before we
// commit to interrupting.
export const ESC_META_CHORD_INTERRUPT_DELAY_MS = 500;

export function appFocusShortcutsActive({
  foregroundOpen,
  reverseSearchOpen,
  slashPaletteOpen,
}: {
  readonly foregroundOpen: boolean;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
}): boolean {
  return !foregroundOpen && !slashPaletteOpen && !reverseSearchOpen;
}

export function appEscapeInterruptActive({
  inputDisabled,
  reverseSearchOpen,
  runPending,
  slashPaletteOpen,
}: {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly runPending: boolean;
  readonly slashPaletteOpen: boolean;
}): boolean {
  return (
    runPending && !inputDisabled && !slashPaletteOpen && !reverseSearchOpen
  );
}

// Bare Esc must give a numbered stream-focus chord a chance to resolve while
// that binding is on screen. `Alt`-chord platforms are unaffected: their
// Esc+key sequences arrive as one burst, resolved synchronously by
// `metaChordInput`.
export function shouldDeferEscapeInterruptForMetaChord({
  shortcutModifierLabel,
  streamFocusAvailable,
}: {
  readonly shortcutModifierLabel: string;
  readonly streamFocusAvailable: boolean;
}): boolean {
  return shortcutModifierLabel === 'Esc' && streamFocusAvailable;
}

export interface EscapeInterruptState {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
  readonly canInterruptActiveRun: () => boolean;
  readonly onInterruptActive: () => void;
}

export function triggerEscapeInterrupt(state: EscapeInterruptState): boolean {
  if (
    !appEscapeInterruptActive({
      inputDisabled: state.inputDisabled,
      reverseSearchOpen: state.reverseSearchOpen,
      runPending: state.canInterruptActiveRun(),
      slashPaletteOpen: state.slashPaletteOpen,
    })
  ) {
    return false;
  }

  state.onInterruptActive();
  return true;
}

export type AppCtrlCAction = 'clear-draft' | 'delegate' | 'interrupt' | 'exit';

export interface AppCtrlCState {
  readonly discardDraft: () => boolean;
  readonly canStopActiveRun: () => boolean;
  readonly onInterruptActive: () => void;
  readonly onExit: () => void;
  readonly onCtrlC?: () => void;
}

export function appDraftDiscardActive({
  inputDisabled,
  reverseSearchOpen,
  childListFocused,
}: {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly childListFocused: boolean;
}): boolean {
  return !inputDisabled && !reverseSearchOpen && !childListFocused;
}

/** Apply the root TUI's complete Ctrl+C policy from the latest composer state. */
export function triggerAppCtrlC(state: AppCtrlCState): AppCtrlCAction {
  if (state.discardDraft()) {
    return 'clear-draft';
  }

  if (state.onCtrlC) {
    state.onCtrlC();
    return 'delegate';
  }

  if (state.canStopActiveRun()) {
    state.onInterruptActive();
    return 'interrupt';
  }

  state.onExit();
  return 'exit';
}

export function digitFromMetaShortcut(value: string): number | undefined {
  return /^[1-9]$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

export type ForegroundSurfaceKind =
  'taskDetail' | 'form' | 'infoPane' | 'approval';

export function foregroundSurfaceKind({
  activeFormOpen,
  formBusy,
  infoPaneOpen,
  pendingApproval,
  taskDetailOpen,
}: {
  readonly activeFormOpen: boolean;
  readonly formBusy: boolean;
  readonly infoPaneOpen: boolean;
  readonly pendingApproval: boolean;
  readonly taskDetailOpen: boolean;
}): ForegroundSurfaceKind | undefined {
  if (taskDetailOpen) return 'taskDetail';
  if (pendingApproval && formBusy) return 'approval';
  if (activeFormOpen) return 'form';
  if (pendingApproval) return 'approval';
  if (infoPaneOpen) return 'infoPane';
  return undefined;
}

export function approvalVisibleForActiveStream({
  activeStreamId,
  pending,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly pending: PendingApproval | undefined;
}): boolean {
  if (!pending) return false;
  const streamId = approvalPayloadStreamId(pending.payload);
  return streamId === undefined || streamId === activeStreamId;
}

export function foregroundEscapeAction({
  activeFormEscapeAction,
  approvalKind,
  foregroundKind,
}: {
  readonly activeFormEscapeAction?: string;
  readonly approvalKind?: ApprovalKind;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
}): string | undefined {
  switch (foregroundKind) {
    case undefined:
      return undefined;
    case 'form':
      return activeFormEscapeAction ?? 'close';
    case 'taskDetail':
      return 'back';
    case 'infoPane':
      return 'close';
    case 'approval':
      return approvalKind === 'externalInquiry' ||
        approvalKind === 'userQuestion'
        ? 'skip'
        : 'cancel';
  }
}

function approvalForegroundMaxRows(
  approvalKind: ApprovalKind | undefined,
): number | undefined {
  if (approvalKind === undefined) return undefined;

  switch (approvalKind) {
    case 'bash':
    case 'toolEdit':
    case 'proposal':
    case 'externalInquiry':
      return APPROVAL_FOREGROUND_MAX_ROWS;
    case 'plan':
    case 'retry':
    case 'userQuestion':
      return undefined;
    default:
      return assertNever(approvalKind, 'Unhandled approval payload kind');
  }
}

export function foregroundMaxRowsForKind({
  approvalKind,
  kind,
}: {
  readonly approvalKind?: ApprovalKind;
  readonly kind: ForegroundSurfaceKind | undefined;
}): number | undefined {
  switch (kind) {
    case 'taskDetail':
      return TASK_DETAIL_FOREGROUND_MAX_ROWS;
    case 'form':
      return FORM_FOREGROUND_MAX_ROWS;
    case 'infoPane':
      return undefined;
    case 'approval':
      return approvalForegroundMaxRows(approvalKind);
    case undefined:
      return undefined;
  }
}
