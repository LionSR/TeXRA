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
} from '@cli/runtime/terminal/terminalText';
import { HOLLOW_DOT, STATUS_DOT } from '@cli/tui/ui/glyphs';
import {
  APPROVE_SESSION_ACTION,
  declineDecision,
  REQUEST_ACTIONS,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import {
  runGrantCliAction,
  RUN_GRANT_ORDER,
} from '@ui/copy/delegationApproval';
import type { ApprovalBypassKind } from '@texra-ai/harness/schemas';

const APPROVAL_PULSE_FRAMES = [STATUS_DOT, HOLLOW_DOT] as const;

/** The request kinds a card answers: those with a `y` answer. */
type ConfirmCardKind = {
  [
    K in keyof typeof REQUEST_ACTIONS
  ]: 'y' extends keyof (typeof REQUEST_ACTIONS)[K] ? K : never;
}[keyof typeof REQUEST_ACTIONS];

type ConfirmCardKey = Pick<ReturnKeyInput, 'escape' | 'ctrl' | 'meta'>;

/** One key of a card's keymap: its hint and what pressing it answers.
 *  `'feedback'` opens the rejection note instead of deciding. */
export interface ConfirmCardKeyRow extends KeyHint {
  readonly decision: SurfaceDecision | 'feedback';
}

export interface ConfirmCardHintOptions<Extra extends KeyHint = KeyHint> {
  /** The request kind answered: what `y`, `n` and Esc send is its row of
   *  `REQUEST_ACTIONS`. A kind that declines with a note opens the note on
   *  `n`; one that stops the task stops it at once. */
  readonly kind: ConfirmCardKind;
  /** Omitted labels are resolved by `confirmCardKeyRows`. */
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  /** The run grant the `a` row turns on (`offeredGrant`); none where the
   *  request offers none. */
  readonly grant?: ApprovalBypassKind | null;
  readonly extraActions?: readonly Extra[];
}

interface ConfirmCardHintWidthOptions extends ConfirmCardHintOptions {
  readonly maxColumns: number;
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
 * it always declines, and `confirmCardKeyHints` appends its hint last.
 */
export function confirmCardKeyRows<Extra extends KeyHint = ConfirmCardKeyRow>({
  kind,
  approveLabel = 'approve',
  rejectLabel,
  grant,
  extraActions = [],
}: ConfirmCardHintOptions<Extra>): (ConfirmCardKeyRow | Extra)[] {
  const feedback = takesNote(kind);
  return [
    { key: 'y', action: approveLabel, decision: REQUEST_ACTIONS[kind].y },
    {
      key: 'n',
      action: rejectLabel ?? (feedback ? 'reject & note' : 'reject'),
      decision: feedback ? 'feedback' : declineDecision(kind),
    },
    ...(grant == null
      ? []
      : [
          {
            key: 'a',
            action: runGrantCliAction(grant).full,
            // A separate key on screen only: `approvalDecisionArm` sends it
            // as a plain approve that grants the request's own session bypass.
            decision: { action: APPROVE_SESSION_ACTION },
          } as const,
        ]),
    ...extraActions,
  ];
}

/** Whether `kind` declines with a note the agent reads. */
function takesNote(kind: ConfirmCardKind): boolean {
  return REQUEST_ACTIONS[kind].n === 'reject';
}

export function confirmCardKeyDecision(
  input: string,
  key: ConfirmCardKey,
  kind: ConfirmCardKind,
  rows: readonly ConfirmCardKeyRow[],
): ConfirmCardKeyRow['decision'] | undefined {
  if (isEscapeInput(input, key)) return declineDecision(kind);
  if (key.ctrl || key.meta) return undefined;
  const pressed = input.toLowerCase();
  return rows.find((row) => row.key.toLowerCase() === pressed)?.decision;
}

function confirmCardKeyHints(options: ConfirmCardHintOptions): KeyHint[] {
  const escapeLabel = takesNote(options.kind)
    ? 'reject'
    : (options.rejectLabel ?? 'reject');
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
  ...Object.fromEntries(
    RUN_GRANT_ORDER.map((kind) => {
      const { full, compact } = runGrantCliAction(kind);
      return [full, compact];
    }),
  ),
  // The plan card's two goal keys, so both fit beside y and n.
  'run as goal': 'goal',
  'goal, approve all': 'all work',
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
    // The one extra key a narrow card keeps: a card's own first action (its
    // narrowest grant, as the plan card's commands-only goal), else `a`.
    compactHints.filter(
      (hint) =>
        isCoreApprovalHint(hint) ||
        hint.key === (options.extraActions?.[0]?.key ?? 'a'),
    ),
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
  ...options
}: ConfirmCardCompactHintLayoutOptions): ConfirmCardCompactHintLayout {
  const pulsedTitleColumns = textDisplayWidth(confirmCardPulsedTitle(0, title));
  const inlineHints = confirmCardKeyHintsForWidth({
    ...options,
    maxColumns: Math.max(
      0,
      columns - pulsedTitleColumns - KEY_HINT_SEPARATOR.length,
    ),
  });
  const stackedHints = confirmCardKeyHintsForWidth({
    ...options,
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
