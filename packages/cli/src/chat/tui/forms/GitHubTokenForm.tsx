import { Text } from 'ink';
import { useState } from 'react';

import { tryOpenBrowser } from '@cli/runtime/browser';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { CROSS } from '@cli/tui/ui/glyphs';
import type { ProcessRuntime } from '@platform/processRuntime';
import { GITHUB_TOKEN_CREATE_URL } from '@tools/github/githubAuth';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatStatusViewSummary } from './_shared/formatStatusViewSummary';
import { ListForm } from './_shared/ListForm';
import { TextEntryForm } from './_shared/TextEntryForm';
import { runFormWrite } from './_shared/useAsyncListForm';
import type { Effect } from 'effect';

/**
 * Which source backs the GitHub token, as `resolveGitHubTokenSource` reports
 * it. The vocabulary lives beside the view that labels it.
 */
type GitHubTokenStatus = 'secret' | 'env' | 'none';

export interface GitHubTokenStatusView {
  readonly status?: GitHubTokenStatus;
  readonly loading: boolean;
  readonly error: boolean;
}

type GitHubTokenAction = 'set' | 'remove' | 'open-url';

const STATUS_LABELS: Readonly<Record<GitHubTokenStatus, string>> = {
  none: 'Not set',
  secret: 'Token set',
  env: 'From GH_TOKEN / GITHUB_TOKEN',
};

export function formatGitHubTokenSummary(view: GitHubTokenStatusView): string {
  return formatStatusViewSummary(
    view,
    'Checking token',
    view.status === undefined ? undefined : STATUS_LABELS[view.status],
  );
}

function buildGitHubTokenActionItems(
  status: GitHubTokenStatus,
): Array<{ value: GitHubTokenAction; label: string; description?: string }> {
  return [
    {
      value: 'set',
      label: status === 'secret' ? 'Replace token' : 'Set token',
      description: 'stored in TeXRA secrets',
    },
    ...(status === 'secret'
      ? [
          {
            value: 'remove' as const,
            label: 'Remove token',
            description: 'forget the stored token',
          },
        ]
      : []),
    {
      value: 'open-url',
      label: 'Create on GitHub…',
      description: 'repo scope pre-selected',
    },
  ];
}

function statusHint(status: GitHubTokenStatus | undefined): string {
  if (status === 'env') {
    return 'A token is already available from GH_TOKEN or GITHUB_TOKEN. Setting one here overrides it.';
  }
  return 'Needs repo for private repos, public_repo for public. Or export GH_TOKEN / GITHUB_TOKEN.';
}

interface GitHubTokenFormProps {
  readonly availableRows?: number;
  readonly statusView?: GitHubTokenStatusView;
  /** The credential writes as programs; this form owns their one run. */
  readonly onSave: (token: string) => Effect.Effect<void, Error>;
  readonly onRemove: () => Effect.Effect<void, Error>;
  /** The runtime those programs settle on, from the surface that mounted this
   *  form — Ink components run no Effect of their own. */
  readonly runtime: ProcessRuntime;
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

  const runAction = (action: () => Effect.Effect<void, Error>): void => {
    setSaving(true);
    runFormWrite(props.runtime, action, {
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
        hint="Stored in TeXRA secrets on Enter — or set GH_TOKEN / GITHUB_TOKEN."
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
  const errorNode = error ? (
    <Text color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text>
  ) : undefined;
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
        runFormWrite(
          props.runtime,
          () => tryOpenBrowser(GITHUB_TOKEN_CREATE_URL),
          {
            onSuccess: (opened) => {
              if (!opened) {
                setError(`Open ${GITHUB_TOKEN_CREATE_URL} to create a token.`);
              }
            },
            onError: (cause) => setError(toErrorMessage(cause)),
          },
        );
      }}
      onCancel={props.onCancel}
    />
  );
}
