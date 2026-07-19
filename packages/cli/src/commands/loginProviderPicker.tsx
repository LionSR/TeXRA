import { render, Box, Text, useApp } from 'ink';

import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import type { OAuthProvider } from '@auth/config';

import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { KeyHints } from '../chat/tui/ui/KeyHints';
import { Select, type SelectItem } from '../chat/tui/ui/Select';
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
  let selected: LoginPickerChoice | undefined;
  const instance = render(
    <LoginProviderPicker
      onSelect={(provider) => {
        selected = provider;
      }}
    />,
    {
      stdout: tuiOutputStreamForColor(process.stdout, colorEnabled),
      stderr: process.stderr,
      stdin: process.stdin,
    },
  );
  await instance.waitUntilExit();
  clearTerminalVisibleScreen();
  return selected;
}
