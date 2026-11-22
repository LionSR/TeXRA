import { Box, Text } from 'ink';

import { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/harness/schemas';
import { loadCliModelAccessOverview } from '@cli/runtime/models/apiStatus';
import type {
  CliLogoutTarget,
  LoginFormValue,
} from '@cli/runtime/models/loginOptions';
import {
  buildCliAccountAccessRows,
  buildCliModelAccessItems,
  CLI_ACCOUNT_ACCESS_DESCRIPTION,
  type CliModelAccessItemsInput,
  type CliModelAccessSelection,
} from '@cli/runtime/models/modelAccessRoute';

import type { SelectItem } from '@cli/tui/ui/Select';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import { OWN_API_KEYS } from '@ui/copy/modelAccess';
import {
  DEVICE_CODE_DESCRIPTION,
  SUBSCRIPTION_AUTH_COPY,
} from '@ui/copy/accountAuth';
import {
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
} from '@ui/copy/onboarding';
import { ListForm } from './_shared/ListForm';
import { useAsyncResource } from './_shared/useAsyncListForm';
import { useChatProcess } from '../chatProcess';

export type AccountAccessFormValue =
  | { readonly kind: 'access'; readonly selection: CliModelAccessSelection }
  | { readonly kind: 'login'; readonly target: LoginFormValue }
  | { readonly kind: 'logout'; readonly target: CliLogoutTarget }
  | { readonly kind: 'key' };

interface AccountAccessFormProps {
  readonly availableRows?: number;
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

interface ProviderSignInTransports {
  readonly provider: SubscriptionProviderId;
  readonly browser: SignInTransport;
  readonly device: SignInTransport;
}

const SIGN_IN_TRANSPORTS: ReadonlyArray<ProviderSignInTransports> =
  SUBSCRIPTION_AUTH_PROVIDERS.map((provider) => {
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
    };
  });

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
  // Signed-out subscriptions get the one sign-in transport their toggle row
  // lacks (device code); the toggle itself is the browser sign-in path.
  for (const entry of SIGN_IN_TRANSPORTS) {
    if (status.subscriptions[entry.provider].signedIn) continue;
    accountItems.push(signInItem(entry.device));
  }
  const signedInCount = SUBSCRIPTION_AUTH_PROVIDERS.filter(
    (provider) => status.subscriptions[provider].signedIn,
  ).length;
  if (signedInCount >= 2) {
    accountItems.push({
      value: { kind: 'logout', target: 'all' },
      label: 'Sign out of all accounts',
      description: 'Sign out of every signed-in account',
    });
  }
  return [...toggleItems, ...accountItems, API_KEY_ITEM];
}

/** The key row of both panels: in `/login` it comes last, so the
 *  subscription rows keep their number hotkeys. */
const API_KEY_ITEM: SelectItem<AccountAccessFormValue> = {
  value: { kind: 'key' },
  label: 'Add a provider API key',
  description: ONBOARDING_CHOICE_API_KEY.description,
};

/**
 * The first-run panel: only what can connect a model, worded as what it does.
 * Nothing is signed in yet (that is why the panel is open), so each
 * subscription row is the same sign-in-and-prefer action its `/login` toggle
 * runs; account management (sign-out) stays in `/login`.
 */
const CONNECT_ITEMS: ReadonlyArray<SelectItem<AccountAccessFormValue>> = [
  ...SUBSCRIPTION_AUTH_PROVIDERS.map(
    (provider): SelectItem<AccountAccessFormValue> => ({
      value: { kind: 'access', selection: { provider, state: 'on' } },
      label: SUBSCRIPTION_AUTH_COPY[provider].connect.label,
      description: SUBSCRIPTION_AUTH_COPY[provider].connect.description,
    }),
  ),
  API_KEY_ITEM,
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

export function AccountAccessForm(
  props: AccountAccessFormProps,
): React.JSX.Element {
  const { roots } = useChatProcess();
  const overview = useAsyncResource({
    load: () => loadCliModelAccessOverview(roots),
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
    detailLines = [`Otherwise: ${OWN_API_KEYS.label}`];
  } else if (error !== undefined) {
    detailLines = [error];
  }

  return (
    <ListForm
      title={
        props.connecting === true ? ONBOARDING_CARD_TITLE : 'Account & access'
      }
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
              <LoadingIndicator label="Loading account access…" />
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
