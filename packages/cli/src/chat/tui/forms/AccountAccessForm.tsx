import { Box, Text } from 'ink';

import { loadCliModelAccessOverview } from '@cli/runtime/apiStatus';
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
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { SUBSCRIPTION_AUTH_PROVIDERS } from '@shared/settingsView/settingsViewMessages';
import { ONBOARDING_CHOICE_CHATGPT } from '@ui/copy/onboarding';
import {
  DEVICE_CODE_DESCRIPTION,
  RESEARCHER_ACCESS_AUTH,
  SUBSCRIPTION_AUTH_COPY,
} from '@ui/copy/accountAuth';
import { ListForm } from './_shared/ListForm';
import { useAsyncResource } from './_shared/useAsyncListForm';

export type AccountAccessFormValue =
  | { readonly kind: 'access'; readonly selection: CliModelAccessSelection }
  | { readonly kind: 'login'; readonly target: LoginFormValue }
  | { readonly kind: 'logout'; readonly target: CliLogoutTarget }
  | { readonly kind: 'key' };

interface AccountAccessFormProps {
  readonly availableRows?: number;
  /**
   * The secret store the access overview reads, with the runtime that settles
   * it: the overview is a program, and Ink components own no runtime, so both
   * arrive as props from the surface that opened this form.
   */
  readonly secrets: PlatformSecrets;
  /** The three setting slots the access overview reads its preferences from. */
  readonly stores: SettingsStores;
  readonly runtime: ProcessRuntime;
  /** No model is connected yet: the form is the chat's "Connect a model"
   *  panel rather than account management. */
  readonly connecting?: boolean;
  readonly onSelect: (value: AccountAccessFormValue) => void;
  readonly onCancel: () => void;
}

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
  ...SUBSCRIPTION_AUTH_PROVIDERS.map((provider) => {
    const copy = SUBSCRIPTION_AUTH_COPY[provider];
    return {
      provider,
      browser: {
        target: provider,
        label: copy.signInLabel,
        description: copy.signInDescription,
      },
      device: {
        target: `${provider} --device` as const,
        label: copy.deviceCodeLabel,
        description: DEVICE_CODE_DESCRIPTION,
      },
      toggleCoversBrowserSignIn: true,
    };
  }),
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
      // transports — this form is where every sign-in and sign-out lives, and recovery
      // actions matter most exactly when account state failed to load.
      return [
        ...toggleItems,
        ...SIGN_IN_TRANSPORTS.flatMap((entry) => [
          signInItem(entry.browser),
          signInItem(entry.device),
        ]),
        API_KEY_ITEM,
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
    chatgpt: status.subscriptions.chatgpt.signedIn,
    grok: status.subscriptions.grok.signedIn,
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
  const signedInCount = Object.values(signedIn).filter(Boolean).length;
  if (signedInCount >= 2) {
    accountItems.push({
      value: { kind: 'logout', target: 'all' },
      label: 'Sign out of all accounts',
      description: 'Sign out of every signed-in account',
    });
  }
  return [...toggleItems, ...accountItems, API_KEY_ITEM];
}

/**
 * The first-run panel: only what can connect a model, worded as what it does.
 * Nothing is signed in yet (that is why the panel is open), so each
 * subscription row is the same sign-in-and-prefer action its `/login` toggle
 * runs; account management (TeXRA account, sign-out) stays in `/login`.
 */
const CONNECT_ITEMS: ReadonlyArray<SelectItem<AccountAccessFormValue>> = [
  {
    value: {
      kind: 'access',
      selection: {
        kind: 'subscription-preference',
        provider: 'chatgpt',
        state: 'on',
      },
    },
    label: ONBOARDING_CHOICE_CHATGPT.label,
    description: ONBOARDING_CHOICE_CHATGPT.description,
  },
  {
    value: {
      kind: 'access',
      selection: {
        kind: 'subscription-preference',
        provider: 'grok',
        state: 'on',
      },
    },
    label: 'Use Grok subscription',
    description: 'Grok models through SuperGrok; no API key needed',
  },
  {
    value: { kind: 'key' },
    label: 'Add a provider API key',
    description:
      'Anthropic, OpenAI, Google, DeepSeek, Kimi Code, GLM, and more',
  },
  signInItem({
    target: 'chatgpt --device',
    label: SUBSCRIPTION_AUTH_COPY.chatgpt.deviceCodeLabel,
    description: DEVICE_CODE_DESCRIPTION,
  }),
  signInItem({
    target: 'grok --device',
    label: SUBSCRIPTION_AUTH_COPY.grok.deviceCodeLabel,
    description: DEVICE_CODE_DESCRIPTION,
  }),
];

// Last, so the subscription rows keep their number hotkeys.
const API_KEY_ITEM: SelectItem<AccountAccessFormValue> = {
  value: { kind: 'key' },
  label: 'Add a provider API key',
  description: 'Anthropic, OpenAI, Google, DeepSeek, and more',
};

export function AccountAccessForm(
  props: AccountAccessFormProps,
): React.JSX.Element {
  const overview = useAsyncResource({
    load: () => loadCliModelAccessOverview(props.stores, props.secrets),
    runtime: props.runtime,
  });
  const { data, error } = overview;

  const items =
    props.connecting === true
      ? CONNECT_ITEMS
      : buildAccountAccessFormItems(
          data !== undefined
            ? { kind: 'loaded', access: data.access }
            : {
                kind: 'pending',
                state: error === undefined ? 'loading' : 'failed',
              },
        );
  let detailLines: readonly string[] | undefined;
  if (data !== undefined) {
    // The rows already describe each preference and account; the detail block
    // only carries what no row says.
    detailLines = [
      `Otherwise: ${formatCliModelAccessRoute('api-key')}`,
      ...(data.note ? [data.note] : []),
    ];
  } else if (error !== undefined) {
    detailLines = [error];
  }

  return (
    <ListForm
      title={props.connecting === true ? 'Connect a model' : 'Account & access'}
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      description={
        <Text dimColor>
          {props.connecting === true
            ? 'TeXRA needs a model to answer. Sign in to a subscription or add an API key.'
            : CLI_ACCOUNT_ACCESS_DESCRIPTION}
        </Text>
      }
      detail={
        props.connecting === true ? undefined : (
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
        )
      }
      detailRows={
        props.connecting === true ? 0 : 1 + (detailLines?.length ?? 1)
      }
      selectMarginTop={1}
      action="select"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
