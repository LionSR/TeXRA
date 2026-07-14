import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

import { KEY_HINT_SEPARATOR } from '../ui/KeyHints';
import { isEscapeInput } from '../input/inputKeys';

export type ConfirmCardKeyAction =
  'approve' | 'reject' | 'approveAlways' | 'feedback' | 'ignore';

export interface ConfirmCardKey {
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export interface ConfirmCardHintAction {
  readonly key: string;
  readonly action: string;
}

export interface ConfirmCardHintOptions {
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly alwaysAllowLabel?: string;
  readonly extraActions?: readonly ConfirmCardHintAction[];
}

export interface ConfirmCardHintWidthOptions extends ConfirmCardHintOptions {
  readonly maxColumns?: number;
}

export interface ConfirmCardCompactHintLayoutOptions extends ConfirmCardHintOptions {
  readonly title: string;
  readonly columns: number;
}

export interface ConfirmCardCompactHintLayout {
  readonly inlineHints: readonly ConfirmCardHintAction[];
  readonly stackedHints: readonly ConfirmCardHintAction[];
  readonly stack: boolean;
}

export function confirmCardKeyAction(
  input: string,
  key: ConfirmCardKey,
  allowAlways: boolean,
): ConfirmCardKeyAction {
  if (isEscapeInput(input, key)) return 'reject';
  if (key.ctrl || key.meta) return 'ignore';
  switch (input.toLowerCase()) {
    case 'y':
      return 'approve';
    case 'n':
      return 'feedback';
    case 'a':
      return allowAlways ? 'approveAlways' : 'ignore';
    default:
      return 'ignore';
  }
}

export function confirmCardKeyHints({
  approveLabel = 'approve',
  rejectLabel = 'reject & note',
  alwaysAllowLabel,
  extraActions = [],
}: ConfirmCardHintOptions): ConfirmCardHintAction[] {
  return [
    { key: 'y', action: approveLabel },
    { key: 'n', action: rejectLabel },
    ...(alwaysAllowLabel == null
      ? []
      : [{ key: 'a', action: alwaysAllowLabel }]),
    ...extraActions,
    { key: 'Esc', action: 'cancel' },
  ];
}

export function confirmCardFeedbackHints(): ConfirmCardHintAction[] {
  return [
    { key: 'Enter', action: 'send note' },
    { key: 'Esc', action: 'back' },
  ];
}

function hintColumns(hints: readonly ConfirmCardHintAction[]): number {
  return hints.reduce(
    (width, hint, index) =>
      width +
      (index === 0 ? 0 : KEY_HINT_SEPARATOR.length) +
      hint.key.length +
      1 +
      hint.action.length,
    0,
  );
}

function hintsFit(
  hints: readonly ConfirmCardHintAction[],
  maxColumns: number | undefined,
): boolean {
  return maxColumns === undefined || hintColumns(hints) <= maxColumns;
}

function compactHintAction(action: string): string {
  switch (action) {
    case 'reject & note':
      return 'reject';
    case 'approve all':
      return 'all';
    case 'approve edits for session':
      return 'edit session';
    case DELEGATION_APPROVAL_COPY.cliAction:
      return DELEGATION_APPROVAL_COPY.cliCompactAction;
    default:
      return action;
  }
}

function isCoreApprovalHint(hint: ConfirmCardHintAction): boolean {
  return hint.key === 'y' || hint.key === 'n' || hint.key === 'Esc';
}

export function confirmCardKeyHintsForWidth(
  options: ConfirmCardHintWidthOptions,
): ConfirmCardHintAction[] {
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

  return [{ key: 'Esc', action: 'cancel' }];
}

export function confirmCardCompactHintLayout({
  title,
  columns,
  approveLabel,
  rejectLabel,
  alwaysAllowLabel,
  extraActions,
}: ConfirmCardCompactHintLayoutOptions): ConfirmCardCompactHintLayout {
  const inlineHints = confirmCardKeyHintsForWidth({
    approveLabel,
    rejectLabel,
    alwaysAllowLabel,
    extraActions,
    maxColumns: Math.max(0, columns - title.length - KEY_HINT_SEPARATOR.length),
  });
  const stackedHints = confirmCardKeyHintsForWidth({
    approveLabel,
    rejectLabel,
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
