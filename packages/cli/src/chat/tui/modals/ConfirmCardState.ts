import { KEY_HINT_SEPARATOR } from '../ui/KeyHints';

export type ConfirmCardKeyAction =
  | 'approve'
  | 'reject'
  | 'approveAlways'
  | 'feedback'
  | 'ignore';

export interface ConfirmCardKey {
  readonly escape?: boolean;
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

export function confirmCardKeyAction(
  input: string,
  key: ConfirmCardKey,
  allowAlways: boolean,
): ConfirmCardKeyAction {
  if (key.escape) return 'reject';
  switch (input.toLowerCase()) {
    case 'y':
      return 'approve';
    case 'n':
      return 'reject';
    case 'a':
      return allowAlways ? 'approveAlways' : 'ignore';
    case 'e':
      return 'feedback';
    default:
      return 'ignore';
  }
}

function confirmCardKeyHints({
  approveLabel = 'approve',
  rejectLabel = 'reject',
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
    { key: 'e', action: 'feedback' },
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

function compactHintAction(action: string): string {
  switch (action) {
    case 'approve session':
      return 'session';
    case 'feedback':
      return 'note';
    default:
      return action;
  }
}

export function confirmCardKeyHintsForWidth(
  options: ConfirmCardHintWidthOptions,
): ConfirmCardHintAction[] {
  const fullHints = confirmCardKeyHints(options);
  if (
    options.maxColumns === undefined ||
    hintColumns(fullHints) <= options.maxColumns
  ) {
    return fullHints;
  }

  return fullHints.map((hint) => ({
    ...hint,
    action: compactHintAction(hint.action),
  }));
}
