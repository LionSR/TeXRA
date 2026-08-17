import { Text } from 'ink';
import { useState } from 'react';

import { tryOpenBrowser } from '@cli/runtime/browser';
import type { GitHubTokenStatus } from '@cli/runtime/githubToken';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { CROSS } from '@cli/tui/ui/glyphs';
import { GITHUB_TOKEN_CREATE_URL } from '@tools/github/githubAuth';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { CredentialEntryForm } from './ApiKeyEntryForm';
import { ListForm } from './_shared/ListForm';

export interface GitHubTokenStatusView {
  readonly status?: GitHubTokenStatus;
  readonly loading: boolean;
  readonly error: boolean;
}

type GitHubTokenAction = 'set' | 'remove' | 'open-url';

export function formatGitHubTokenSummary(view: GitHubTokenStatusView): string {
  if (!view.status) {
    if (view.loading && !view.error) return 'Checking token';
    return 'Status unavailable';
  }
  let label = 'Not set';
  if (view.status === 'secret') label = 'Token set';
  else if (view.status === 'env') label = 'From GH_TOKEN / GITHUB_TOKEN';
  if (view.error) return `${label} · status unavailable`;
  return view.loading ? `${label} · refreshing` : label;
}

function buildGitHubTokenActionItems(status: GitHubTokenStatus) {
  const items: Array<{
    value: GitHubTokenAction;
    label: string;
    description?: string;
  }> = [
    {
      value: 'set',
      label: status === 'secret' ? 'Replace token' : 'Set token',
      description: 'stored in TeXRA secrets',
    },
  ];
  if (status === 'secret') {
    items.push({
      value: 'remove',
      label: 'Remove token',
      description: 'forget the stored token',
    });
  }
  items.push({
    value: 'open-url',
    label: 'Create on GitHub…',
    description: 'repo scope pre-selected',
  });
  return items;
}

function statusHint(status: GitHubTokenStatus | undefined): string {
  if (status === 'env') {
    return 'A token is already available from GH_TOKEN or GITHUB_TOKEN. Setting one here overrides it.';
  }
  return 'Needs repo for private repos, public_repo for public. Or export GH_TOKEN / GITHUB_TOKEN.';
}

export interface GitHubTokenFormProps {
  readonly availableRows?: number;
  readonly statusView?: GitHubTokenStatusView;
  readonly onSave: (token: string) => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/** Masked GitHub PAT entry and status, kept inside the CLI process. */
export function GitHubTokenForm(
  props: GitHubTokenFormProps,
): React.JSX.Element {
  const [entering, setEntering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (entering) {
    return (
      <GitHubTokenEntryForm
        error={error}
        saving={saving}
        onCancel={() => {
          setError(undefined);
          setEntering(false);
        }}
        onSubmit={(token) => {
          setSaving(true);
          void props
            .onSave(token)
            .then(() => props.onDone())
            .catch((saveError: unknown) => {
              setSaving(false);
              setError(toErrorMessage(saveError));
            });
        }}
      />
    );
  }

  const status = props.statusView?.status ?? 'none';
  return (
    <ListForm
      title="GitHub token"
      availableRows={props.availableRows}
      items={buildGitHubTokenActionItems(status)}
      description={
        <Text dimColor>
          {formatGitHubTokenSummary({
            status: props.statusView?.status,
            loading: props.statusView?.loading ?? false,
            error: props.statusView?.error ?? false,
          })}
          {'. '}
          {statusHint(props.statusView?.status)}
        </Text>
      }
      detail={
        error ? (
          <Text color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text>
        ) : undefined
      }
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
          setSaving(true);
          void props
            .onRemove()
            .then(() => props.onDone())
            .catch((removeError: unknown) => {
              setSaving(false);
              setError(toErrorMessage(removeError));
            });
          return;
        }
        void tryOpenBrowser(GITHUB_TOKEN_CREATE_URL).then((opened) => {
          if (!opened) {
            setError(`Open ${GITHUB_TOKEN_CREATE_URL} to create a token.`);
          }
        });
      }}
      onCancel={props.onCancel}
    />
  );
}

function GitHubTokenEntryForm(props: {
  readonly error?: string;
  readonly saving?: boolean;
  readonly onSubmit: (token: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <CredentialEntryForm
      title="Set GitHub token"
      helper={<Text dimColor>Get a token: {GITHUB_TOKEN_CREATE_URL}</Text>}
      placeholder="enter your GitHub token (hidden)"
      savedHint="Stored in TeXRA secrets on Enter — or set GH_TOKEN / GITHUB_TOKEN."
      {...props}
    />
  );
}
