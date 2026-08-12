import { isEscapeInput } from '@cli/tui/inputKeys';
import {
  KEY_HINT_SEPARATOR,
  keyHintText,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { APPROVAL_PULSE_FRAMES } from '@cli/tui/ui/glyphs';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

import { textDisplayWidth } from '../render/terminalText';

export type ConfirmCardKeyAction =
  'approve' | 'reject' | 'approveAlways' | 'feedback' | 'ignore';

export type ConfirmCardRejectionMode = 'feedback' | 'immediate';

export interface ConfirmCardKey {
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export interface ConfirmCardKeyOptions {
  readonly allowAlways: boolean;
  readonly rejectionMode: ConfirmCardRejectionMode;
}

export interface ConfirmCardHintOptions {
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  /** Esc maps to `reject` (`confirmCardKeyAction`), not a dismiss — label the consequence. */
  readonly escapeLabel?: string;
  readonly alwaysAllowLabel?: string;
  readonly extraActions?: readonly KeyHint[];
}

export interface ConfirmCardHintWidthOptions extends ConfirmCardHintOptions {
  readonly maxColumns?: number;
}

export interface ConfirmCardCompactHintLayoutOptions extends ConfirmCardHintOptions {
  readonly title: string;
  readonly columns: number;
}

export interface ConfirmCardCompactHintLayout {
  readonly inlineHints: readonly KeyHint[];
  readonly stackedHints: readonly KeyHint[];
  readonly stack: boolean;
}

/**
 * A pending approval always needs the user's eyes on it — prefix the title
 * with a 1 Hz solid/hollow blink (see `ui/glyphs.APPROVAL_PULSE_FRAMES`) off
 * the shared clock, same pattern as `LoadingIndicator` and the status bar's
 * running marker, so the card is harder to miss than a static line.
 */
export function confirmCardPulsedTitle(nowMs: number, title: string): string {
  return `${loadingFrameAt(nowMs, APPROVAL_PULSE_FRAMES)} ${title}`;
}

export function confirmCardKeyAction(
  input: string,
  key: ConfirmCardKey,
  options: ConfirmCardKeyOptions,
): ConfirmCardKeyAction {
  if (isEscapeInput(input, key)) return 'reject';
  if (key.ctrl || key.meta) return 'ignore';
  switch (input.toLowerCase()) {
    case 'y':
      return 'approve';
    case 'n':
      return options.rejectionMode === 'feedback' ? 'feedback' : 'reject';
    case 'a':
      return options.allowAlways ? 'approveAlways' : 'ignore';
    default:
      return 'ignore';
  }
}

export function confirmCardKeyHints({
  approveLabel = 'approve',
  rejectLabel = 'reject & note',
  escapeLabel = 'reject',
  alwaysAllowLabel,
  extraActions = [],
}: ConfirmCardHintOptions): KeyHint[] {
  return [
    { key: 'y', action: approveLabel },
    { key: 'n', action: rejectLabel },
    ...(alwaysAllowLabel == null
      ? []
      : [{ key: 'a', action: alwaysAllowLabel }]),
    ...extraActions,
    { key: 'Esc', action: escapeLabel },
  ];
}

export function confirmCardFeedbackHints(): KeyHint[] {
  return [
    { key: 'Enter', action: 'send note' },
    { key: 'Esc', action: 'back' },
  ];
}

// Reuses the canonical `keyHintText` projection (see its doc comment) so this
// measures exactly what KeyHints renders, instead of re-deriving the format.
function hintColumns(hints: readonly KeyHint[]): number {
  return textDisplayWidth(hints.map(keyHintText).join(KEY_HINT_SEPARATOR));
}

function hintsFit(
  hints: readonly KeyHint[],
  maxColumns: number | undefined,
): boolean {
  return maxColumns === undefined || hintColumns(hints) <= maxColumns;
}

function compactHintAction(action: string): string {
  switch (action) {
    case 'reject & note':
      return 'reject';
    case 'approve commands for session':
      return 'all commands';
    case 'approve edits for session':
      return 'all edits';
    case DELEGATION_APPROVAL_COPY.cliAction:
      return DELEGATION_APPROVAL_COPY.cliCompactAction;
    default:
      return action;
  }
}

function isCoreApprovalHint(hint: KeyHint): boolean {
  return hint.key === 'y' || hint.key === 'n' || hint.key === 'Esc';
}

export function confirmCardKeyHintsForWidth(
  options: ConfirmCardHintWidthOptions,
): KeyHint[] {
  const fullHints = confirmCardKeyHints(options);
  if (hintsFit(fullHints, options.maxColumns)) return fullHints;

  const compactHints = fullHints.map((hint) => ({
    ...hint,
    action: compactHintAction(hint.action),
  }));
  if (hintsFit(compactHints, options.maxColumns)) return compactHints;

  const withoutExtraActions = compactHints.filter(
    (hint) => isCoreApprovalHint(hint) || hint.key === 'a',
  );
  if (hintsFit(withoutExtraActions, options.maxColumns)) {
    return withoutExtraActions;
  }

  const coreHints = compactHints.filter(isCoreApprovalHint);
  if (hintsFit(coreHints, options.maxColumns)) return coreHints;

  return [{ key: 'Esc', action: options.escapeLabel ?? 'reject' }];
}

export function confirmCardCompactHintLayout({
  title,
  columns,
  approveLabel,
  rejectLabel,
  escapeLabel,
  alwaysAllowLabel,
  extraActions,
}: ConfirmCardCompactHintLayoutOptions): ConfirmCardCompactHintLayout {
  const pulsedTitleColumns = textDisplayWidth(confirmCardPulsedTitle(0, title));
  const inlineHints = confirmCardKeyHintsForWidth({
    approveLabel,
    rejectLabel,
    escapeLabel,
    alwaysAllowLabel,
    extraActions,
    maxColumns: Math.max(
      0,
      columns - pulsedTitleColumns - KEY_HINT_SEPARATOR.length,
    ),
  });
  const stackedHints = confirmCardKeyHintsForWidth({
    approveLabel,
    rejectLabel,
    escapeLabel,
    alwaysAllowLabel,
    extraActions,
    maxColumns: columns,
  });
  return {
    inlineHints,
    stackedHints,
    stack:
      inlineHints.some((hint) => hint.key === 'Esc') &&
      stackedHints.length > inlineHints.length,
  };
}

export function confirmCardCompactChromeRows(
  options: ConfirmCardCompactHintLayoutOptions,
): number {
  return confirmCardCompactHintLayout(options).stack ? 2 : 1;
}
