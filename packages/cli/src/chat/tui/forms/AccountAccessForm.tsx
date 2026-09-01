import { Box, Text } from 'ink';
import { useState } from 'react';

import {
  loadCliModelAccessOverview,
  type CliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import type {
  CliLogoutTarget,
  LoginFormValue,
} from '@cli/runtime/loginOptions';
import {
  buildCliAccountAccessRows,
  buildCliModelAccessItems,
  CLI_ACCOUNT_ACCESS_DESCRIPTION,
  formatCliModelAccessRoute,
  type CliModelAccessItemsInput,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';

import type { SelectItem } from '@cli/tui/ui/Select';
import { useCancellableEffect } from '@cli/tui/useCancellableEffect';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import {
  CHATGPT_AUTH,
  DEVICE_CODE_DESCRIPTION,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
} from '@shared/copy/accountAuth';
import { ListForm } from './_shared/ListForm';

export type AccountAccessFormValue =
  | { readonly kind: 'access'; readonly selection: CliModelAccessSelection }
  | { readonly kind: 'login'; readonly target: LoginFormValue }
  | { readonly kind: 'logout'; readonly target: CliLogoutTarget };

interface AccountAccessFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: AccountAccessFormValue) => void;
  readonly onCancel: () => void;
}

type AccountAccessFormStatus =
  | { readonly state: 'loaded'; readonly overview: CliModelAccessOverview }
  | { readonly state: 'failed'; readonly message: string };

interface SignInTransport {
  readonly target: LoginFormValue;
  readonly label: string;
  readonly description: string;
}

type SignInProvider = 'chatgpt' | 'grok' | 'texra';

interface ProviderSignInTransports {
  readonly provider: SignInProvider;
  readonly browser: SignInTransport;
  readonly device: SignInTransport;
  readonly toggleCoversBrowserSignIn: boolean;
}

const SIGN_IN_TRANSPORTS: ReadonlyArray<ProviderSignInTransports> = [
  {
    provider: 'chatgpt',
    browser: {
      target: 'chatgpt',
      label: CHATGPT_AUTH.signInLabel,
      description: 'Use a ChatGPT subscription',
    },
    device: {
      target: 'chatgpt --device',
      label: CHATGPT_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    },
    toggleCoversBrowserSignIn: true,
  },
  {
    provider: 'grok',
    browser: {
      target: 'grok',
      label: GROK_AUTH.signInLabel,
      description: 'Use a Grok / SuperGrok subscription',
    },
    device: {
      target: 'grok --device',
      label: GROK_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    },
    toggleCoversBrowserSignIn: true,
  },
  {
    provider: 'texra',
    browser: {
      target: 'texra',
      label: RESEARCHER_ACCESS_AUTH.signInLabel,
      description: RESEARCHER_ACCESS_AUTH.loginDescription,
    },
    device: {
      target: 'texra --device',
      label: RESEARCHER_ACCESS_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    },
    toggleCoversBrowserSignIn: false,
  },
];

function signInItem(
  transport: SignInTransport,
): SelectItem<AccountAccessFormValue> {
  return {
    value: { kind: 'login' as const, target: transport.target },
    label: transport.label,
    description: transport.description,
  };
}

function buildAccountAccessFormItems(
  input: CliModelAccessItemsInput,
): ReadonlyArray<SelectItem<AccountAccessFormValue>> {
  const toggleItems = buildCliModelAccessItems(input).map((item) => ({
    value: { kind: 'access' as const, selection: item.value },
    label: item.label,
    description: item.description,
    ...(item.disabled === true ? { disabled: true } : {}),
  }));
  if (input.kind !== 'loaded') {
    if (input.state === 'failed') {
      // Account state is unknown, so the form keeps every provider's sign-in
      // transports — this same form backs /login and /logout, and recovery
      // actions matter most exactly when account state failed to load.
      return [
        ...toggleItems,
        ...SIGN_IN_TRANSPORTS.flatMap((entry) => [
          signInItem(entry.browser),
          signInItem(entry.device),
        ]),
      ];
    }
    return toggleItems;
  }

  const status = input.access;
  const accountItems: Array<SelectItem<AccountAccessFormValue>> =
    buildCliAccountAccessRows(status).map((row) => ({
      value:
        row.operation === 'sign-out'
          ? ({ kind: 'logout', target: row.provider } as const)
          : ({ kind: 'login', target: row.provider } as const),
      label: row.label,
      description: row.description,
    }));
  const signedIn: Record<SignInProvider, boolean> = {
    chatgpt: status.chatGptSignedIn,
    grok: status.grokSignedIn,
    texra: status.texraSignedIn ?? false,
  };
  // Signed-out subscriptions get the one sign-in transport their toggle row
  // lacks (device code); the toggle itself is the browser sign-in path.
  for (const entry of SIGN_IN_TRANSPORTS) {
    if (signedIn[entry.provider]) continue;
    if (!entry.toggleCoversBrowserSignIn) {
      accountItems.push(signInItem(entry.browser));
    }
    accountItems.push(signInItem(entry.device));
  }
  const signedInCount = [
    status.chatGptSignedIn,
    status.grokSignedIn,
    status.texraSignedIn,
  ].filter(Boolean).length;
  if (signedInCount >= 2) {
    accountItems.push({
      value: { kind: 'logout', target: 'all' },
      label: 'Sign out of all accounts',
      description: 'Sign out of every signed-in account',
    });
  }
  return [...toggleItems, ...accountItems];
}

export function AccountAccessForm(
  props: AccountAccessFormProps,
): React.JSX.Element {
  const [status, setStatus] = useState<AccountAccessFormStatus | null>(null);

  useCancellableEffect((isCancelled) => {
    setStatus(null);
    void loadCliModelAccessOverview()
      .then((overview) => {
        if (!isCancelled()) setStatus({ state: 'loaded', overview });
      })
      .catch((error: unknown) => {
        if (!isCancelled()) {
          setStatus({
            state: 'failed',
            message: String(error),
          });
        }
      });
  }, []);

  const items = buildAccountAccessFormItems(
    status?.state === 'loaded'
      ? { kind: 'loaded', access: status.overview.access }
      : { kind: 'pending', state: status?.state ?? 'loading' },
  );
  let detailLines: readonly string[] | undefined;
  if (status?.state === 'loaded') {
    // The rows already describe each preference and account; the detail block
    // only carries what no row says.
    detailLines = [
      `Otherwise: ${formatCliModelAccessRoute('personal')}`,
      ...(status.overview.note ? [status.overview.note] : []),
    ];
  } else if (status?.state === 'failed') {
    detailLines = [status.message];
  }

  return (
    <ListForm
      title="Account & access"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      description={<Text dimColor>{CLI_ACCOUNT_ACCESS_DESCRIPTION}</Text>}
      detail={
        <Box marginTop={1} flexDirection="column">
          {detailLines === undefined ? (
            <LoadingIndicator label="loading account access..." />
          ) : (
            detailLines.map((line, index) => (
              <Text key={`${index}:${line}`} dimColor>
                {line}
              </Text>
            ))
          )}
        </Box>
      }
      detailRows={1 + (detailLines?.length ?? 1)}
      selectMarginTop={1}
      action="select"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
