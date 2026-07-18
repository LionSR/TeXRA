import { Text } from 'ink';

import type { CliLogoutTarget } from '@cli/runtime/loginOptions';

import { ListForm } from './_shared/ListForm';
import type { SelectItem } from '../ui/Select';

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
    description: 'Sign out of included TeXRA access',
  },
  {
    value: 'all',
    label: 'All accounts',
    description: 'Sign out of both account sessions',
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
