// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import { CommandDirs } from '@texra-ai/harness/node';
import { vscodeOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { inputBox } from '@frontend/ui/dialogs';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import { announce, showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  cloneOverleafProject as runOverleafClone,
  type OverleafCloneOutcome,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  parseLatexGitUrl,
  type OverleafRemote,
} from '@latex/overleafProject';
import {
  installAdvice,
  LATEX_TOOL_ENTRIES,
} from '@texra/shared/constants/latexToolchain';
import { osPlatformOf } from '@texra/shared/osPlatform';
import { CLONE_COPY, cloneProviderLabel } from '@ui/copy/clone';
import { hasPackageManager } from '@texra/utils/system/toolChecks';
import {
  Secrets,
  withLogChannel,
  WorkspaceFs,
  type PlatformSecrets,
} from '@texra-ai/harness/plugins';

const CHANNEL = 'gitCommands';

/** Hand a URL to the browser; a failure is logged, not raised, because the
 *  dialogs that offer it have nothing further to do about one. */
const openUrl = (url: string) =>
  vscodeOpener
    .openExternal(url)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning(`Could not open ${url}: ${failure.message}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );

const promptInput = Effect.fn('promptInput')(function* (
  title: string,
  prompt: string,
  password = false,
): Effect.fn.Return<string | null, HostFailed> {
  const val = yield* inputBox({
    title,
    prompt,
    password,
    ignoreFocusOut: true,
  });
  const trimmed = val?.trim() ?? '';
  if (!trimmed) {
    // Show cancellation message only if user dismissed with empty string (not Escape)
    if (val !== undefined) {
      yield* vscodeUi.notify('warning', CLONE_COPY.cancelled);
    }
    return null;
  }
  return trimmed;
});

const promptGitMissing = Effect.fnUntraced(function* () {
  const platform = osPlatformOf(process.platform);
  const advice = installAdvice('Git', ['git'], platform);
  const downloadUrl = LATEX_TOOL_ENTRIES.git.install.url?.[platform];
  // The command is worth offering only where its package manager is
  // installed.
  const command =
    advice.command &&
    hasPackageManager(advice.command.packageManager, (yield* CommandDirs)())
      ? advice.command.command
      : null;
  const message = CLONE_COPY.gitMissing(platform);

  const actions = [
    ...(command ? (['Copy Command', 'Run in Terminal'] as const) : []),
    ...(downloadUrl ? (['Open git-scm.com'] as const) : []),
  ];

  yield* Effect.logError(message).pipe(withLogChannel(CHANNEL));
  const selected = yield* announce(
    vscodeUi.ask('error', message, { items: actions }),
    undefined,
  );
  if (selected === 'Copy Command' && command) {
    yield* Effect.tryPromise({
      try: async () => vscode.env.clipboard.writeText(command),
      catch: (cause) => hostFailed('clipboard.writeText', cause),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not copy the command: ${error.message}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );
  } else if (selected === 'Run in Terminal' && command) {
    const terminal = vscode.window.createTerminal('Install Git');
    terminal.show();
    terminal.sendText(command);
  } else if (selected === 'Open git-scm.com' && downloadUrl) {
    yield* openUrl(downloadUrl);
  }
});

/** Wire the shared Overleaf/ShareLaTeX clone workflow to the secret store
 *  and VS Code's input prompts and progress UI. All decision logic (token
 *  validation, precondition checks, auth-failure handling) lives in
 *  `@latex/overleafClone`. */
function buildOverleafClonePorts(
  secrets: PlatformSecrets,
  label: string,
): OverleafCloneWorkflowPorts {
  return {
    // A credential store this host cannot reach fails the clone with its
    // `SecretsFailed`, which the workflow's `Error` channel carries.
    secrets,
    promptToken: (spec) =>
      promptInput(
        spec.tokenTitle,
        spec.tokenHint ?? 'Enter your Git authentication token.',
        true,
      ),
    showProgress: (clone) =>
      withVSCodeProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${label}…`,
        },
        () => clone,
      ),
  };
}

/** Show the clone's outcome. A cancelled prompt has already said so. */
const presentCloneOutcome = Effect.fn('gitCommands.presentCloneOutcome')(
  function* (
    remote: OverleafRemote,
    workspaceRoot: string,
    outcome: OverleafCloneOutcome,
  ) {
    switch (outcome._tag) {
      case 'Cloned':
        return yield* vscodeUi.notify(
          'info',
          CLONE_COPY.cloned(remote, outcome.destination),
        );
      case 'Cancelled':
        return;
      case 'InvalidToken': {
        yield* Effect.logError(outcome.message);
        const action = yield* announce(
          vscodeUi.ask('error', outcome.message, {
            items: outcome.spec.tokenHint ? ['How to get a token'] : [],
          }),
          undefined,
        );
        if (action === 'How to get a token') {
          yield* openUrl(OVERLEAF_TOKEN_DOCS_URL);
        }
        return;
      }
      case 'GitMissing':
        return yield* promptGitMissing();
      case 'WorkspaceUnreadable':
        yield* showLoggedMessage(CLONE_COPY.unreadable(outcome.message));
        return;
      case 'WorkspaceNotEmpty':
        yield* showLoggedMessage(
          `${CLONE_COPY.notEmpty(workspaceRoot)} Open an empty folder, then clone again.`,
        );
        return;
      case 'AuthFailure': {
        yield* Effect.logError(`Clone failed: ${outcome.error}`);
        const selected = yield* announce(
          vscodeUi.ask(
            'error',
            `${CLONE_COPY.authFailed} ${CLONE_COPY.authDetail(remote)}`,
            {
              items: remote.isOverleaf
                ? ['Get New Token', 'How to get a token']
                : ['Retry'],
            },
          ),
          undefined,
        );
        if (selected === 'Get New Token') {
          yield* openUrl(OVERLEAF_GIT_TOKEN_URL);
        } else if (selected === 'How to get a token') {
          yield* openUrl(OVERLEAF_TOKEN_DOCS_URL);
        }
        return;
      }
      case 'CloneFailed':
        yield* Effect.logError(`Clone failed: ${outcome.error}`);
        return yield* vscodeUi.notify('error', CLONE_COPY.failed);
    }
  },
  withLogChannel(CHANNEL),
);

export const cloneOverleafProject = Effect.fn('cloneOverleafProject')(
  function* () {
    const input = yield* promptInput(
      'Clone Overleaf/ShareLaTeX Project',
      'Enter project URL or 24-character project ID.',
    );
    if (!input) return;

    const remote = parseLatexGitUrl(input);
    if (!remote) {
      yield* showLoggedMessage('Invalid project URL or ID.');
      return;
    }

    // The session's workspace view names the clone target. The view is the
    // one the command root provided; this depth only reads it.
    const workspaceRoot = (yield* WorkspaceFs).root;
    if (!workspaceRoot) {
      yield* showLoggedMessage('Open a workspace folder first.');
      return;
    }
    const label = cloneProviderLabel(remote);
    const outcome = yield* runOverleafClone(
      remote,
      workspaceRoot,
      buildOverleafClonePorts(yield* Secrets, label),
    );
    yield* presentCloneOutcome(remote, workspaceRoot, outcome);
  },
  withLogChannel(CHANNEL),
);
