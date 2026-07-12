import { Box, Text } from 'ink';

import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import { isCompactFormRows } from './_shared/selectWindow';

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
  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame title="/login" showCloseHint={false}>
        <Select
          items={LOGIN_FORM_ITEMS}
          maxVisibleItems={LOGIN_FORM_ITEMS.length}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
        <CompactFormKeyHints
          primary={{ key: '1-4/Enter', action: 'select' }}
          escapeAction="cancel"
        />
      </FormFrame>
    );
  }

  return (
    <FormFrame title="/login" showCloseHint={false}>
      <Text dimColor>Choose how TeXRA should authenticate model calls.</Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={LOGIN_FORM_ITEMS}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-4', action: 'select now' },
            { key: 'Enter', action: 'select highlighted' },
            { key: 'Esc', action: 'cancel' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
