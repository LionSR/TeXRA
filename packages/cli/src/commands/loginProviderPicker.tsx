import { Box, Text, useApp } from 'ink';

import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
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
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        TeXRA login
      </Text>
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
      <Box marginTop={1}>
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
      </Box>
    </Box>
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
