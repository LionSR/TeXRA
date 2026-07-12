// Local imports - CLI TUI
import { textDisplayWidth } from '../render/terminalText';
import { KEY_HINT_SEPARATOR, keyHintText, type KeyHint } from '../ui/KeyHints';
import type { ChildControlMode } from '../state/childControls';

function keyHintsDisplayWidth(hints: readonly KeyHint[]): number {
  return textDisplayWidth(hints.map(keyHintText).join(KEY_HINT_SEPARATOR));
}

function keyHintsFit(
  hints: readonly KeyHint[],
  availableColumns: number | undefined,
): boolean {
  return (
    availableColumns === undefined ||
    keyHintsDisplayWidth(hints) <= availableColumns
  );
}

type PickerOptionalHint = 'focus' | 'jump' | 'kill';

function pickerHintsForOptionals(
  mode: ChildControlMode,
  itemCount: number,
  canKill: boolean,
  selected: ReadonlySet<PickerOptionalHint>,
  availableColumns: number | undefined,
): readonly KeyHint[] {
  return [
    {
      key: '↑/↓',
      action: availableColumns === undefined ? 'navigate' : 'nav',
    },
    ...(selected.has('jump') && itemCount > 1
      ? [{ key: '1-9', action: 'jump' }]
      : []),
    { key: 'Enter', action: 'view' },
    ...(selected.has('focus') && mode === 'subagents'
      ? [{ key: 'f', action: 'focus' }]
      : []),
    ...(selected.has('kill') && canKill ? [{ key: 'k', action: 'kill' }] : []),
    { key: 'Esc', action: 'close' },
  ];
}

export function pickerKeyHintsForColumns(
  mode: ChildControlMode,
  itemCount: number,
  canKill = itemCount > 0,
  availableColumns?: number,
): readonly KeyHint[] {
  if (itemCount <= 0) return [{ key: 'Esc', action: 'close' }];

  const selected = new Set<PickerOptionalHint>();
  const priority: readonly PickerOptionalHint[] =
    mode === 'subagents' ? ['focus', 'jump', 'kill'] : ['kill', 'jump'];

  for (const option of priority) {
    const nextSelected = new Set(selected);
    nextSelected.add(option);
    const nextHints = pickerHintsForOptionals(
      mode,
      itemCount,
      canKill,
      nextSelected,
      availableColumns,
    );
    if (keyHintsFit(nextHints, availableColumns)) selected.add(option);
  }

  return pickerHintsForOptionals(
    mode,
    itemCount,
    canKill,
    selected,
    availableColumns,
  );
}
