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
  buildCliModelAccessItems,
  CLI_ACCOUNT_ACCESS_DESCRIPTION,
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
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
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

/**
 * Rows of the merged account & access form, deduped per provider by state:
 * the preference toggle is ChatGPT's and Grok's browser sign-in path, so a
 * signed-out subscription only gets the device-code row the toggle lacks and
 * a signed-in one only gets sign-out. TeXRA has no toggle, so it keeps its
 * own sign-in rows.
 */
function buildAccountAccessFormItems(
  input: CliModelAccessItemsInput,
): ReadonlyArray<SelectItem<AccountAccessFormValue>> {
  const toggleItems = buildCliModelAccessItems(input).map((item) => ({
    value: { kind: 'access' as const, selection: item.value },
    label: item.label,
    description: item.description,
    ...(item.disabled === true ? { disabled: true } : {}),
  }));
  if (input.kind !== 'loaded') return toggleItems;

  const status = input.access;
  const accountItems: Array<SelectItem<AccountAccessFormValue>> = [];
  if (status.chatGptSignedIn) {
    accountItems.push({
      value: { kind: 'logout', target: 'chatgpt' },
      label: CHATGPT_AUTH.signOutLabel,
      description: status.chatGptAccountLabel ?? CHATGPT_AUTH.subscriptionLabel,
    });
  } else {
    accountItems.push({
      value: { kind: 'login', target: 'chatgpt --device' },
      label: CHATGPT_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    });
  }
  if (status.grokSignedIn) {
    accountItems.push({
      value: { kind: 'logout', target: 'grok' },
      label: GROK_AUTH.signOutLabel,
      description: status.grokAccountLabel ?? GROK_AUTH.subscriptionLabel,
    });
  } else {
    accountItems.push({
      value: { kind: 'login', target: 'grok --device' },
      label: GROK_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    });
  }
  if (status.texraSignedIn === true) {
    accountItems.push({
      value: { kind: 'logout', target: 'texra' },
      label: `Sign out of ${RESEARCHER_ACCESS.label}`,
      description: status.texraAccountLabel ?? RESEARCHER_ACCESS.label,
    });
  } else {
    accountItems.push({
      value: { kind: 'login', target: 'texra' },
      label: RESEARCHER_ACCESS.label,
      description: RESEARCHER_ACCESS_AUTH.loginDescription,
    });
    accountItems.push({
      value: { kind: 'login', target: 'texra --device' },
      label: RESEARCHER_ACCESS_AUTH.deviceCodeLabel,
      description: DEVICE_CODE_DESCRIPTION,
    });
  }
  const signedInCount = [
    status.chatGptSignedIn,
    status.grokSignedIn,
    status.texraSignedIn === true,
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
    detailLines = status.overview.lines;
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
