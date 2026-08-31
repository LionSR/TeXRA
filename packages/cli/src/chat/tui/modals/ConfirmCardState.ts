import { isEscapeInput, type ReturnKeyInput } from '@cli/tui/inputKeys';
import {
  KEY_HINT_SEPARATOR,
  keyHintsText,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import {
  firstFittingCandidate,
  textDisplayWidth,
} from '@cli/runtime/terminalText';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

const APPROVAL_PULSE_FRAMES = ['●', '○'] as const;

type ConfirmCardKeyAction =
  'approve' | 'reject' | 'approveAlways' | 'feedback' | 'ignore';

export type ConfirmCardRejectionMode = 'feedback' | 'immediate';

type ConfirmCardKey = Pick<ReturnKeyInput, 'escape' | 'ctrl' | 'meta'>;

interface ConfirmCardKeyOptions {
  readonly allowAlways: boolean;
  readonly rejectionMode: ConfirmCardRejectionMode;
}

interface ConfirmCardHintOptions {
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly rejectionMode?: ConfirmCardRejectionMode;
  readonly alwaysAllowLabel?: string;
  readonly extraActions?: readonly KeyHint[];
}

interface ConfirmCardHintWidthOptions extends ConfirmCardHintOptions {
  readonly maxColumns?: number;
}

interface ConfirmCardCompactHintLayoutOptions extends ConfirmCardHintOptions {
  readonly title: string;
  readonly columns: number;
}

interface ConfirmCardCompactHintLayout {
  readonly inlineHints: readonly KeyHint[];
  readonly stackedHints: readonly KeyHint[];
  readonly stack: boolean;
}

/**
 * A pending approval always needs the user's eyes on it — prefix the title
 * with a 1 Hz solid/hollow blink off the shared clock, same pattern as
 * `LoadingIndicator` and the status bar's running marker, so the card is
 * harder to miss than a static line.
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
  rejectLabel,
  rejectionMode = 'feedback',
  alwaysAllowLabel,
  extraActions = [],
}: ConfirmCardHintOptions): KeyHint[] {
  const resolvedRejectLabel =
    rejectLabel ?? (rejectionMode === 'feedback' ? 'reject & note' : 'reject');
  const resolvedEscapeLabel =
    rejectionMode === 'immediate' ? resolvedRejectLabel : 'reject';
  return [
    { key: 'y', action: approveLabel },
    { key: 'n', action: resolvedRejectLabel },
    ...(alwaysAllowLabel == null
      ? []
      : [{ key: 'a', action: alwaysAllowLabel }]),
    ...extraActions,
    { key: 'Esc', action: resolvedEscapeLabel },
  ];
}

export function confirmCardFeedbackHints(): KeyHint[] {
  return [
    { key: 'Enter', action: 'send note' },
    { key: 'Esc', action: 'back' },
  ];
}

const COMPACT_HINT_ACTIONS: Readonly<Record<string, string>> = {
  'reject & note': 'reject',
  'approve commands for session': 'all commands',
  'approve edits for session': 'all edits',
  [DELEGATION_APPROVAL_COPY.cliAction]:
    DELEGATION_APPROVAL_COPY.cliCompactAction,
};

function isCoreApprovalHint(hint: KeyHint): boolean {
  return hint.key === 'y' || hint.key === 'n' || hint.key === 'Esc';
}

export function confirmCardKeyHintsForWidth(
  options: ConfirmCardHintWidthOptions,
): KeyHint[] {
  const fullHints = confirmCardKeyHints(options);
  const compactHints = fullHints.map((hint) => ({
    ...hint,
    action: COMPACT_HINT_ACTIONS[hint.action] ?? hint.action,
  }));
  const candidates: readonly KeyHint[][] = [
    fullHints,
    compactHints,
    compactHints.filter((hint) => isCoreApprovalHint(hint) || hint.key === 'a'),
    compactHints.filter(isCoreApprovalHint),
  ];
  return firstFittingCandidate({
    candidates,
    fallback: fullHints.slice(-1),
    maxColumns: options.maxColumns,
    measure: (hints) => textDisplayWidth(keyHintsText(hints)),
  });
}

export function confirmCardCompactHintLayout({
  title,
  columns,
  approveLabel,
  rejectLabel,
  rejectionMode,
  alwaysAllowLabel,
  extraActions,
}: ConfirmCardCompactHintLayoutOptions): ConfirmCardCompactHintLayout {
  const pulsedTitleColumns = textDisplayWidth(confirmCardPulsedTitle(0, title));
  const inlineHints = confirmCardKeyHintsForWidth({
    approveLabel,
    rejectLabel,
    rejectionMode,
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
    rejectionMode,
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
