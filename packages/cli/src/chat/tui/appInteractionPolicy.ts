/** Pure foreground-surface and keyboard interaction policy for the root TUI. */

import { isUnhandledControlInput, metaChordInput } from '@cli/tui/inputKeys';
// Local imports - shared schemas and utilities
import { type RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { Key } from 'ink';

// Local imports - TUI state
import type {
  PendingApproval,
  PendingApprovalKind,
} from './state/approvalQueue';

export const FORM_FOREGROUND_MAX_ROWS = 18;
// Match form sizing for approval modals that already budget or scroll their
// content. Natural-height approvals stay uncapped until they grow row budgets.
export const APPROVAL_FOREGROUND_MAX_ROWS: Record<
  PendingApprovalKind,
  number | undefined
> = {
  bash: FORM_FOREGROUND_MAX_ROWS,
  toolEdit: FORM_FOREGROUND_MAX_ROWS,
  proposal: FORM_FOREGROUND_MAX_ROWS,
  planApproval: undefined,
  retry: undefined,
  userQuestion: undefined,
};

// A bare Esc and the second key of an `Esc 1..9` chord are two
// separate keystrokes on terminals without true Meta-key detection (macOS
// Terminal.app). 125ms was too tight for a deliberate but unhurried chord
// (issue #7496: a ~400ms pause after Esc fired the bare-Esc
// interrupt and stopped a suspended WAITING subagent); widen to a
// tmux-style chord window so a human-paced chord still resolves before we
// commit to interrupting.
export const ESC_META_CHORD_INTERRUPT_DELAY_MS = 500;

/** Text a pending `Esc` chord resolves: a key that types, not Enter, an
 *  arrow, an editing chord or a Ctrl/Alt combination. */
export function chordTextInput(input: string, key: Key): boolean {
  return (
    input.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    !key.return &&
    metaChordInput(input, key) === undefined &&
    [...input].every((character) => !isUnhandledControlInput(character))
  );
}

export type ForegroundSurfaceKind = 'form' | 'infoPane' | 'approval' | 'reader';

export function foregroundSurfaceKind({
  activeFormOpen,
  formBusy,
  infoPaneOpen,
  pendingApproval,
  readerOpen,
}: {
  readonly activeFormOpen: boolean;
  readonly formBusy: boolean;
  readonly infoPaneOpen: boolean;
  readonly pendingApproval: boolean;
  readonly readerOpen: boolean;
}): ForegroundSurfaceKind | undefined {
  if (pendingApproval && formBusy) return 'approval';
  if (activeFormOpen) return 'form';
  if (pendingApproval) return 'approval';
  if (infoPaneOpen) return 'infoPane';
  // Lowest precedence: the reader is a passive view, so anything that needs an
  // answer from the user takes the foreground away from it.
  return readerOpen ? 'reader' : undefined;
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
  // A stream-less request carries an empty run id.
  const runId = pending.payload.data.runId || undefined;
  if (runId === undefined || runId === selectedRunId) return true;
  const asking = view.runs.get(runId);
  return (
    asking?.ancestors.some((ancestor) => ancestor.id === selectedRunId) ?? false
  );
}
