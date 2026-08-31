import { Text } from 'ink';

import type { SelectItem } from '@cli/tui/ui/Select';

import { ListForm } from './_shared/ListForm';

export interface GoalModeFormProps {
  readonly autoApproveAll: boolean;
  readonly availableRows?: number;
  readonly onToggle: (enabled: boolean) => void;
  readonly onClose: () => void;
}

/** Goal-mode reference and its session-local approval-scope toggle. */
export function GoalModeForm(props: GoalModeFormProps): React.JSX.Element {
  const items: ReadonlyArray<SelectItem<boolean>> = [
    {
      value: !props.autoApproveAll,
      label: 'Auto-approve all goal work',
      description: props.autoApproveAll
        ? 'On · commands, file edits, and delegated work; other prompts still ask'
        : 'Off · commands only; edits and other prompts still ask',
    },
  ];
  return (
    <ListForm
      title="/goal"
      compactTitle="/goal · Configure autonomous goal mode."
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={1}
      description={
        <Text dimColor>
          Run an approved plan until it finishes, pauses, or you stop it.
        </Text>
      }
      selectMarginTop={1}
      action="toggle"
      onSelect={props.onToggle}
      onCancel={props.onClose}
    />
  );
}
