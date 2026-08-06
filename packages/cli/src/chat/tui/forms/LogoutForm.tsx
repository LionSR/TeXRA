import { Text } from 'ink';

import type { CliLogoutTarget } from '@cli/runtime/loginOptions';

import type { SelectItem } from '@cli/tui/ui/Select';
import { CHATGPT_AUTH, RESEARCHER_ACCESS_AUTH } from '@shared/copy/accountAuth';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import { ListForm } from './_shared/ListForm';

interface LogoutFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: CliLogoutTarget) => void;
  readonly onCancel: () => void;
}

const LOGOUT_FORM_ITEMS = [
  {
    value: 'chatgpt',
    label: CHATGPT_AUTH.label,
    description: CHATGPT_AUTH.logoutDescription,
  },
  {
    value: 'texra',
    label: RESEARCHER_ACCESS.label,
    description: RESEARCHER_ACCESS_AUTH.logoutDescription,
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
