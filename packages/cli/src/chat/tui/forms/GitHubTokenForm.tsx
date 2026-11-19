import { Text } from 'ink';
import { useState } from 'react';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import { tryOpenBrowser } from '@cli/runtime/models/browser';
import { ToneLine } from '@cli/tui/ui/ToneLine';
import {
  GITHUB_TOKEN_CREATE_URL,
  GITHUB_TOKEN_ENV_VARS,
} from '@texra/tools/github/githubAuth';
import { credentialOriginLabel, TOKEN_ACTION_COPY } from '@ui/copy/credentials';

import { formatStatusViewSummary } from './_shared/formatStatusViewSummary';
import { ListForm } from './_shared/ListForm';
import { TextEntryForm } from './_shared/TextEntryForm';
import { runFormWrite } from './_shared/useAsyncListForm';
import type { CredentialOrigin } from '@texra-ai/llm';
import type { Secrets } from '@texra-ai/harness/plugins';
import type { Effect } from 'effect';
import { useChatProcess } from '../chatProcess';

export interface GitHubTokenStatusView {
  /** Which source backs the GitHub token, as `resolveGitHubTokenSource`
   *  reports it. */
  readonly status?: CredentialOrigin;
  readonly loading: boolean;
  readonly error: boolean;
}

type GitHubTokenAction = 'set' | 'remove' | 'open-url';

export function formatGitHubTokenSummary(view: GitHubTokenStatusView): string {
  return formatStatusViewSummary(
    view,
    'Checking token',
    view.status === undefined
      ? undefined
      : credentialOriginLabel(view.status, 'token'),
  );
}

function buildGitHubTokenActionItems(
  status: CredentialOrigin,
): Array<{ value: GitHubTokenAction; label: string; description?: string }> {
  return [
    {
      value: 'set',
      label:
        status === 'secret' ? TOKEN_ACTION_COPY.replace : TOKEN_ACTION_COPY.set,
      description: 'stored in TeXRA secrets',
    },
    ...(status === 'secret'
      ? [
          {
            value: 'remove' as const,
            label: TOKEN_ACTION_COPY.remove,
            description: 'forget the stored token',
          },
        ]
      : []),
    {
      value: 'open-url',
      label: TOKEN_ACTION_COPY.create,
      description: 'repo scope pre-selected',
    },
  ];
}

function statusHint(status: CredentialOrigin | undefined): string {
  if (status === 'env') {
    return `A token is already available from ${GITHUB_TOKEN_ENV_VARS.join(' or ')}. Setting one here overrides it.`;
  }
  return `Needs repo for private repos, public_repo for public. Or export ${GITHUB_TOKEN_ENV_VARS.join(' / ')}.`;
}

interface GitHubTokenFormProps {
  readonly availableRows?: number;
  readonly statusView?: GitHubTokenStatusView;
  /** The credential writes as programs; this form owns their one run. */
  readonly onSave: (token: string) => Effect.Effect<void, Error, Secrets>;
  readonly onRemove: () => Effect.Effect<void, Error, Secrets>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/** Masked GitHub PAT entry and status, kept inside the CLI process. */
export function GitHubTokenForm(
  props: GitHubTokenFormProps,
): React.JSX.Element {
  const { chat } = useChatProcess();
  const [entering, setEntering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const runAction = (
    action: () => Effect.Effect<void, Error, Secrets>,
  ): void => {
    setSaving(true);
    runFormWrite(chat, action, {
      onSuccess: props.onDone,
      onError: (cause) => {
        setSaving(false);
        setError(toErrorMessage(cause));
      },
    });
  };

  if (entering) {
    return (
      <TextEntryForm
        title="Set GitHub token"
        helper={<Text dimColor>Get a token: {GITHUB_TOKEN_CREATE_URL}</Text>}
        placeholder="enter your GitHub token (hidden)"
        hint={`Stored in TeXRA secrets on Enter — or set ${GITHUB_TOKEN_ENV_VARS.join(' / ')}.`}
        error={error}
        saving={saving}
        onCancel={() => {
          setError(undefined);
          setEntering(false);
        }}
        onSubmit={(token) => runAction(() => props.onSave(token))}
      />
    );
  }

  const status = props.statusView?.status ?? 'none';
  const loading = props.statusView?.loading ?? false;
  const statusError = props.statusView?.error ?? false;
  const errorNode = error ? <ToneLine tone="danger" text={error} /> : undefined;
  return (
    <ListForm
      title="GitHub token"
      availableRows={props.availableRows}
      items={buildGitHubTokenActionItems(status)}
      description={
        <Text dimColor>
          {formatGitHubTokenSummary({ status, loading, error: statusError })}
          {'. '}
          {statusHint(status)}
        </Text>
      }
      detail={errorNode}
      detailRows={errorNode ? 1 : 0}
      compactDetail={errorNode}
      action="select"
      escapeAction="back"
      onSelect={(action) => {
        if (saving) return;
        setError(undefined);
        if (action === 'set') {
          setEntering(true);
          return;
        }
        if (action === 'remove') {
          runAction(() => props.onRemove());
          return;
        }
        runFormWrite(chat, () => tryOpenBrowser(GITHUB_TOKEN_CREATE_URL), {
          onSuccess: (opened) => {
            if (!opened) {
              setError(`Open ${GITHUB_TOKEN_CREATE_URL} to create a token.`);
            }
          },
          onError: (cause) => setError(toErrorMessage(cause)),
        });
      }}
      onCancel={props.onCancel}
    />
  );
}
