/** Pure foreground-surface and keyboard interaction policy for the root TUI. */

// Local imports - shared schemas and utilities
import { type RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { assertNever } from '@utils/core';

// Local imports - TUI state

import {
  approvalPayloadRunId,
  type PendingApproval,
  type PendingApprovalKind,
} from './state/approvalQueue';

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

export interface EscapeInterruptState {
  /** The committed render's focus-shortcut gate: no foreground surface, child
   *  list, reverse search, or slash palette owns the keyboard. Bare Escape's
   *  deferred chord timer reads it through a ref so it sees that render. */
  readonly shortcutsActive: boolean;
  readonly canInterruptRun: (runId: RunId) => boolean;
  readonly onInterruptRun: (runId: RunId) => void;
}

export interface AppCtrlCState {
  readonly discardDraft: () => boolean;
  readonly onCtrlC: () => void;
}

/** Apply the root TUI's complete Ctrl+C policy from the latest composer state:
 *  the first Ctrl+C discards a draft, and anything past that is the host's
 *  SIGINT policy. */
export function triggerAppCtrlC(state: AppCtrlCState): void {
  if (state.discardDraft()) return;
  state.onCtrlC();
}

export type ForegroundSurfaceKind =
  | 'form'
  | 'infoPane'
  | 'approval'
  | 'transcriptReader'
  | 'workPlanReader'
  | 'workflowPopup';

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
  readonly readerKind: 'transcript' | 'workPlan' | 'workflow' | undefined;
}): ForegroundSurfaceKind | undefined {
  if (pendingApproval && formBusy) return 'approval';
  if (activeFormOpen) return 'form';
  if (pendingApproval) return 'approval';
  if (infoPaneOpen) return 'infoPane';
  // Lowest precedence: the reader is a passive view, so anything that needs an
  // answer from the user takes the foreground away from it.
  if (readerKind === 'workPlan') return 'workPlanReader';
  if (readerKind === 'transcript') return 'transcriptReader';
  if (readerKind === 'workflow') return 'workflowPopup';
  return undefined;
}

/**
 * Whether the pending request shows on the selected stream: a stream-less
 * request everywhere, a stream's own request on that stream and on every
 * ancestor. A descendant's decision is taken from the parent the user is on,
 * so presenting one never moves the selection (the fold's
 * `approval: 'descendant'`, PRD 5.2); a request outside the selected subtree
 * waits behind the status bar's count and the session list's marker until
 * the user goes to it.
 */
export function approvalVisibleForSelection({
  pending,
  selectedRunId,
  view,
}: {
  readonly pending: PendingApproval | undefined;
  readonly selectedRunId: RunId | undefined;
  readonly view: SessionView;
}): boolean {
  if (!pending) return false;
  const runId = approvalPayloadRunId(pending.payload);
  if (runId === undefined || runId === selectedRunId) return true;
  const asking = view.runs.get(runId);
  return (
    asking?.ancestors.some((ancestor) => ancestor.id === selectedRunId) ?? false
  );
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
    case 'workflowPopup':
      return 'close';
    case 'approval':
      // Esc rejects (confirmCardKeyAction); label the consequence, not "cancel".
      if (approvalKind === 'userQuestion') return 'skip';
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
    case 'workflowPopup':
      return undefined;
    case 'approval':
      return approvalForegroundMaxRows(approvalKind);
    case undefined:
      return undefined;
  }
}
