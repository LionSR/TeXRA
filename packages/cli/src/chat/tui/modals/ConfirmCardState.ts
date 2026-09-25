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
import {
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import { DELEGATION_APPROVAL_COPY } from '@ui/copy/delegationApproval';

const APPROVAL_PULSE_FRAMES = ['●', '○'] as const;

export type ConfirmCardRejectionMode = 'feedback' | 'immediate';

type ConfirmCardKey = Pick<ReturnKeyInput, 'escape' | 'ctrl' | 'meta'>;

/** One key of a card's keymap: its hint and what pressing it answers.
 *  `'feedback'` opens the rejection note instead of deciding. */
export interface ConfirmCardKeyRow extends KeyHint {
  readonly decision: SurfaceDecision | 'feedback';
}

export interface ConfirmCardHintOptions<Extra extends KeyHint = KeyHint> {
  /** Omitted labels are resolved by `confirmCardKeyRows`. */
  readonly approveLabel?: string;
  /**
   * What the approve key answers with, for a request a plain approve does not
   * answer: the retry card's `y` is `{ action: 'retry' }`, because a retry
   * request reads its consent off that arm and nothing else. Defaults to a
   * plain approve.
   */
  readonly approveDecision?: SurfaceDecision;
  readonly rejectLabel?: string;
  readonly rejectionMode?: ConfirmCardRejectionMode;
  /** Label of the `a` session-bypass action; omitted where the request kind
   *  offers none. */
  readonly alwaysAllowLabel?: string;
  readonly extraActions?: readonly Extra[];
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

/**
 * The card's keymap in hint order, one row per letter key. Esc is not a row:
 * it always rejects, and `confirmCardKeyHints` appends its hint last.
 */
export function confirmCardKeyRows<Extra extends KeyHint = ConfirmCardKeyRow>({
  approveLabel = 'approve',
  approveDecision = { action: 'approve' },
  rejectLabel,
  rejectionMode = 'feedback',
  alwaysAllowLabel,
  extraActions = [],
}: ConfirmCardHintOptions<Extra>): (ConfirmCardKeyRow | Extra)[] {
  const feedback = rejectionMode === 'feedback';
  return [
    { key: 'y', action: approveLabel, decision: approveDecision },
    {
      key: 'n',
      action: rejectLabel ?? (feedback ? 'reject & note' : 'reject'),
      decision: feedback ? 'feedback' : { action: 'reject' },
    },
    ...(alwaysAllowLabel == null
      ? []
      : [
          {
            key: 'a',
            action: alwaysAllowLabel,
            // Surface-only (ruling A9-6): `approvalDecisionArms` decomposes
            // it into the request's own session bypass plus a plain approve.
            decision: { action: APPROVE_SESSION_ACTION },
          } as const,
        ]),
    ...extraActions,
  ];
}

export function confirmCardKeyDecision(
  input: string,
  key: ConfirmCardKey,
  rows: readonly ConfirmCardKeyRow[],
): ConfirmCardKeyRow['decision'] | undefined {
  if (isEscapeInput(input, key)) return { action: 'reject' };
  if (key.ctrl || key.meta) return undefined;
  const pressed = input.toLowerCase();
  return rows.find((row) => row.key.toLowerCase() === pressed)?.decision;
}

function confirmCardKeyHints(options: ConfirmCardHintOptions): KeyHint[] {
  const escapeLabel =
    options.rejectionMode === 'immediate'
      ? (options.rejectLabel ?? 'reject')
      : 'reject';
  return [...confirmCardKeyRows(options), { key: 'Esc', action: escapeLabel }];
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
