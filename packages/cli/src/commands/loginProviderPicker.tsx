import { Box, Text, useApp } from 'ink';

import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { isLikelyRemoteSession } from '../runtime/remoteSession';
import { CLI_OAUTH_PROVIDER_ITEMS } from '../runtime/oauthProviderDisplay';

/** Browser-based provider sign-in, or the device-code flow for remote shells. */
export type LoginPickerChoice = OAuthProvider | 'device';

const LOGIN_PICKER_ITEMS: readonly SelectItem<LoginPickerChoice>[] = [
  ...CLI_OAUTH_PROVIDER_ITEMS,
  {
    value: 'device',
    label: 'Device code',
    description: 'sign in from a browser on any device (SSH-friendly)',
  },
];

function LoginProviderPicker(props: {
  readonly onSelect: (provider: LoginPickerChoice | undefined) => void;
}): React.JSX.Element {
  const app = useApp();
  const remoteSession = isLikelyRemoteSession();
  const finish = (provider: LoginPickerChoice | undefined): void => {
    props.onSelect(provider);
    app.exit();
  };

  return (
    <BorderedPanel
      color={COLOR_HINT}
      title="TeXRA login"
      footer={
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            {
              key: `1-${LOGIN_PICKER_ITEMS.length}/Enter`,
              action: 'select',
            },
            { key: 'Esc', action: 'cancel' },
          ]}
          confirmCancel={false}
        />
      }
    >
      <Text dimColor>Choose how to sign in:</Text>
      {remoteSession ? (
        <Text dimColor>
          Remote session detected — the device code option works without a
          callback port.
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Select<LoginPickerChoice>
          items={LOGIN_PICKER_ITEMS}
          activeValue={remoteSession ? 'device' : DEFAULT_OAUTH_PROVIDER}
          onSelect={finish}
          onCancel={() => finish(undefined)}
        />
      </Box>
    </BorderedPanel>
  );
}

export async function promptForLoginProvider(
  colorEnabled = true,
): Promise<LoginPickerChoice | undefined> {
  return renderCliPrompt<LoginPickerChoice | undefined>(
    (resolve) => <LoginProviderPicker onSelect={resolve} />,
    { stdout: process.stdout, stderr: process.stderr, colorEnabled },
  );
}
