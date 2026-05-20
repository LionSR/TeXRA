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

export function confirmCardKeyHints({
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
