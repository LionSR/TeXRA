import { render, Box, Text, useApp } from 'ink';

import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import type { OAuthProvider } from '@auth/sharedConfig';

import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { KeyHints } from '../chat/tui/ui/KeyHints';
import { Select, type SelectItem } from '../chat/tui/ui/Select';

const LOGIN_PROVIDER_ITEMS = [
  { value: 'github', label: 'GitHub' },
  { value: 'google', label: 'Google' },
] as const satisfies readonly SelectItem<OAuthProvider>[];

function LoginProviderPicker(props: {
  readonly onSelect: (provider: OAuthProvider | undefined) => void;
}): React.JSX.Element {
  const app = useApp();
  const finish = (provider: OAuthProvider | undefined): void => {
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
      <Text dimColor>Choose a provider to sign in with:</Text>
      <Box marginTop={1} flexDirection="column">
        <Select<OAuthProvider>
          items={LOGIN_PROVIDER_ITEMS}
          activeValue={DEFAULT_OAUTH_PROVIDER}
          onSelect={finish}
          onCancel={() => finish(undefined)}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-2/Enter', action: 'select' },
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
): Promise<OAuthProvider | undefined> {
  let selected: OAuthProvider | undefined;
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
