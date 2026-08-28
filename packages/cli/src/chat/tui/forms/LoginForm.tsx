import { Text } from 'ink';

import type { SelectItem } from '@cli/tui/ui/Select';
import {
  CHATGPT_AUTH,
  DEVICE_CODE_DESCRIPTION,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
} from '@shared/copy/accountAuth';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import { ListForm } from './_shared/ListForm';

export type LoginFormValue =
  | 'texra'
  | 'chatgpt'
  | 'grok'
  | 'texra --device'
  | 'chatgpt --device'
  | 'grok --device';

export interface LoginFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: LoginFormValue) => void;
  readonly onCancel: () => void;
}

export const LOGIN_FORM_ITEMS = [
  {
    value: 'chatgpt',
    label: CHATGPT_AUTH.subscriptionLabel,
    description: CHATGPT_AUTH.subscriptionDescription,
  },
  {
    value: 'grok',
    label: GROK_AUTH.subscriptionLabel,
    description: GROK_AUTH.subscriptionDescription,
  },
  {
    value: 'texra',
    label: RESEARCHER_ACCESS.label,
    description: RESEARCHER_ACCESS_AUTH.loginDescription,
  },
  {
    value: 'chatgpt --device',
    label: CHATGPT_AUTH.deviceCodeLabel,
    description: DEVICE_CODE_DESCRIPTION,
  },
  {
    value: 'grok --device',
    label: GROK_AUTH.deviceCodeLabel,
    description: DEVICE_CODE_DESCRIPTION,
  },
  {
    value: 'texra --device',
    label: RESEARCHER_ACCESS_AUTH.deviceCodeLabel,
    description: DEVICE_CODE_DESCRIPTION,
  },
] as const satisfies ReadonlyArray<SelectItem<LoginFormValue>>;

export function LoginForm(props: LoginFormProps): React.JSX.Element {
  return (
    <ListForm
      title="/login"
      availableRows={props.availableRows}
      items={LOGIN_FORM_ITEMS}
      compactVisibleItems={LOGIN_FORM_ITEMS.length}
      description={<Text dimColor>Choose an account to sign in.</Text>}
      selectMarginTop={1}
      action="select"
      escapeAction="cancel"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
