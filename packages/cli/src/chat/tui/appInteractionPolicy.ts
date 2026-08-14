/** Pure foreground-surface and keyboard interaction policy for the root TUI. */

// Local imports - shared schemas and utilities
import { type StreamTabId } from '@shared/schemas';
import { assertNever, groupBy } from '@utils/core';

// Local imports - TUI state
import {
  approvalPayloadStreamId,
  ROOT_APPROVAL_STREAM_KEY,
  type PendingApproval,
  type PendingApprovalKind,
  type PendingApprovalSummary,
} from './state/approvalQueue';
import type { StreamSlice } from './state/cliState';

const FORM_FOREGROUND_MAX_ROWS = 18;
// Match form sizing for approval modals that already budget or scroll their
// content. Natural-height approvals stay uncapped until they grow row budgets.
const APPROVAL_FOREGROUND_MAX_ROWS = 18;

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
  readonly canInterruptStream: (streamId: StreamTabId) => boolean;
  readonly onInterruptStream: (streamId: StreamTabId) => void;
}

export function triggerEscapeInterrupt(
  state: EscapeInterruptState,
  streamId: StreamTabId | undefined,
): boolean {
  if (
    streamId === undefined ||
    !appEscapeInterruptActive({
      inputDisabled: state.inputDisabled,
      reverseSearchOpen: state.reverseSearchOpen,
      runPending: state.canInterruptStream(streamId),
      slashPaletteOpen: state.slashPaletteOpen,
    })
  ) {
    return false;
  }

  state.onInterruptStream(streamId);
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
  'form' | 'infoPane' | 'approval' | 'transcriptReader' | 'workPlanReader';

export function foregroundSurfaceKind({
  activeFormOpen,
  formBusy,
  infoPaneOpen,
  pendingApproval,
  readerKind,
}: {
  readonly activeFormOpen: boolean;
  readonly formBusy: boolean;
  readonly infoPaneOpen: boolean;
  readonly pendingApproval: boolean;
  readonly readerKind: 'transcript' | 'workPlan' | undefined;
}): ForegroundSurfaceKind | undefined {
  if (pendingApproval && formBusy) return 'approval';
  if (activeFormOpen) return 'form';
  if (pendingApproval) return 'approval';
  if (infoPaneOpen) return 'infoPane';
  // Lowest precedence: the reader is a passive view, so anything that needs an
  // answer from the user takes the foreground away from it.
  if (readerKind === 'workPlan') return 'workPlanReader';
  if (readerKind === 'transcript') return 'transcriptReader';
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
  readonly approvalKind?: PendingApprovalKind;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
}): string | undefined {
  switch (foregroundKind) {
    case undefined:
      return undefined;
    case 'form':
      return activeFormEscapeAction ?? 'close';
    case 'infoPane':
    case 'transcriptReader':
    case 'workPlanReader':
      return 'close';
    case 'approval':
      // Esc rejects (confirmCardKeyAction); label the consequence, not "cancel".
      if (
        approvalKind === 'externalInquiry' ||
        approvalKind === 'userQuestion'
      ) {
        return 'skip';
      }
      return approvalKind === 'retry' ? 'give up' : 'reject';
  }
}

function approvalForegroundMaxRows(
  approvalKind: PendingApprovalKind | undefined,
): number | undefined {
  if (approvalKind === undefined) return undefined;

  switch (approvalKind) {
    case 'bash':
    case 'toolEdit':
    case 'proposal':
    case 'externalInquiry':
      return APPROVAL_FOREGROUND_MAX_ROWS;
    case 'planApproval':
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
  readonly approvalKind?: PendingApprovalKind;
  readonly kind: ForegroundSurfaceKind | undefined;
}): number | undefined {
  switch (kind) {
    case 'form':
      return FORM_FOREGROUND_MAX_ROWS;
    // The reader is the whole point of the keystroke: like the info pane, it
    // takes every row the layout can spare rather than a modal-sized window.
    case 'infoPane':
    case 'transcriptReader':
    case 'workPlanReader':
      return undefined;
    case 'approval':
      return approvalForegroundMaxRows(approvalKind);
    case undefined:
      return undefined;
  }
}

// Group the flat FIFO summaries per row, folding stream-less (session-wide)
// approvals onto the root of the visible surface: normally the main row, or
// the workflow-dashboard heading while that surface replaces the session
// list. Grouping from the flat list keeps each row's first shown kind the
// first-to-present even when bound and stream-less items interleave globally.
export function groupPendingApprovalsByRow(
  summaries: readonly PendingApprovalSummary[],
  rootStreamId: StreamTabId | undefined,
): Map<string, PendingApprovalKind[]> {
  const keyed: { key: string; summary: PendingApprovalSummary }[] = [];
  for (const summary of summaries) {
    const key =
      summary.streamKey === ROOT_APPROVAL_STREAM_KEY
        ? rootStreamId
        : summary.streamKey;
    if (key !== undefined) keyed.push({ key, summary });
  }
  return groupBy(
    keyed,
    (entry) => entry.key,
    (entry) => entry.summary.kind,
  );
}

/** Row key that owns stream-less approvals on the currently visible surface. */
export function visibleApprovalRootStreamId(
  sessionRootStreamId: StreamTabId | undefined,
  childListRootStreamId: StreamTabId | undefined,
): StreamTabId | undefined {
  return childListRootStreamId ?? sessionRootStreamId;
}

// A workflow-script grandchild `agent()` call is the only interactively
// skip/retry-able row: a NATIVE agent run (no external CLI tool — those
// children are driven by their own tool and would no-op here) whose parent
// stream IS the workflow-script run — one identity hop, which excludes the
// run stream itself so its row never shows a control that would silently
// no-op.
export function selectedChildRowWorkflowControllable({
  parentStream,
  selectedChildKillable,
  selectedChildStreamId,
  streams,
}: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly selectedChildKillable: boolean;
  readonly selectedChildStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): boolean {
  if (!selectedChildKillable || selectedChildStreamId === undefined) {
    return false;
  }
  const parentOfSelectedChild = parentStream.get(selectedChildStreamId);
  const childIdentity = streams.get(selectedChildStreamId)?.identity;
  return (
    childIdentity?.kind === 'agent' &&
    childIdentity.tool === undefined &&
    parentOfSelectedChild !== undefined &&
    streams.get(parentOfSelectedChild)?.identity?.kind === 'multiAgentWorkflow'
  );
}
