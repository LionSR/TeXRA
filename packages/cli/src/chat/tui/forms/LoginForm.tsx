import { Text } from 'ink';

import { ListForm } from './_shared/ListForm';
import type { SelectItem } from '../ui/Select';

export type LoginFormValue =
  'texra' | 'chatgpt' | 'texra --device' | 'chatgpt --device';

export interface LoginFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: LoginFormValue) => void;
  readonly onCancel: () => void;
}

export const LOGIN_FORM_ITEMS = [
  {
    value: 'chatgpt',
    label: 'ChatGPT subscription',
    description: 'Codex via ChatGPT Plus/Pro/Team',
  },
  {
    value: 'texra',
    label: 'Researcher Access',
    description: 'Included models and remote agents',
  },
  {
    value: 'chatgpt --device',
    label: 'ChatGPT device code',
    description: 'sign in from SSH or another browser',
  },
  {
    value: 'texra --device',
    label: 'Researcher device code',
    description: 'sign in from SSH or another browser',
  },
] as const satisfies ReadonlyArray<SelectItem<LoginFormValue>>;

export function LoginForm(props: LoginFormProps): React.JSX.Element {
  return (
    <ListForm
      title="/login"
      availableRows={props.availableRows}
      items={LOGIN_FORM_ITEMS}
      compactVisibleItems={LOGIN_FORM_ITEMS.length}
      description={
        <Text dimColor>Choose how TeXRA should authenticate model calls.</Text>
      }
      selectMarginTop={1}
      action="select"
      escapeAction="cancel"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
