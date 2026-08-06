import { Text } from 'ink';

import type { CliLogoutTarget } from '@cli/runtime/loginOptions';

import type { SelectItem } from '@cli/tui/ui/Select';
import { ListForm } from './_shared/ListForm';

interface LogoutFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: CliLogoutTarget) => void;
  readonly onCancel: () => void;
}

const LOGOUT_FORM_ITEMS = [
  {
    value: 'chatgpt',
    label: 'ChatGPT',
    description: 'Sign out and disable subscription preference',
  },
  {
    value: 'texra',
    label: 'Researcher Access',
    description: 'Sign out of your TeXRA account',
  },
  {
    value: 'all',
    label: 'All accounts',
    description: 'Sign out of both accounts',
  },
] as const satisfies ReadonlyArray<SelectItem<CliLogoutTarget>>;

export function LogoutForm(props: LogoutFormProps): React.JSX.Element {
  return (
    <ListForm
      title="/logout"
      availableRows={props.availableRows}
      items={LOGOUT_FORM_ITEMS}
      compactVisibleItems={LOGOUT_FORM_ITEMS.length}
      description={<Text dimColor>Choose which account to sign out.</Text>}
      selectMarginTop={1}
      action="select"
      escapeAction="cancel"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
