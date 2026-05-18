export type ConfirmCardKeyAction =
  | 'approve'
  | 'reject'
  | 'approveAlways'
  | 'feedback'
  | 'ignore';

export interface ConfirmCardKey {
  readonly escape?: boolean;
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
