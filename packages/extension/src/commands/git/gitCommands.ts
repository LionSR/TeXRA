// Third-party imports
import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import * as vscode from 'vscode';

// Local imports - utilities
import {
  withLogChannel,
  type RootedFileSystem,
  WorkspaceFs,
} from '@texra-ai/harness';
import { executeCommand, findCommand } from '@texra-ai/harness/node';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { type HostPromptFailed, inputBox } from '@frontend/ui/dialogs';
import { announce, showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  cloneOverleafProject as runOverleafClone,
  gitClone,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  parseLatexGitUrl,
  type OverleafRemote,
} from '@latex/overleafProject';
import { COMMIT_HASH_PATTERN } from '@texra/utils/git/commitHashPattern';
import { COMMIT_LABEL_FORMAT } from '@texra/utils/git/commitLogFormat';
import type { PlatformSecrets, WorkspaceRoots } from '@texra-ai/harness';

const CHANNEL = 'gitCommands';

/** Hand a URL to the browser; a refusal is logged, not raised, because the
 *  dialogs that offer it have nothing further to do about one. */
const openUrl = (url: string) =>
  new VscodeExternalOpener()
    .openExternal(url)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning(`Could not open ${url}: ${failure.message}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );

export function findCommitInHistory(
  roots: WorkspaceRoots,
  commitHash: string,
  rootPath?: string,
) {
  return Effect.gen(function* () {
    if (typeof commitHash !== 'string') {
      return null;
    }

    const sanitizedCommit = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(sanitizedCommit)) {
      return null;
    }

    const workspacePath = rootPath ?? roots.workspace;
    if (!workspacePath) {
      return null;
    }

    const gitOptions = {
      cwd: workspacePath,
      settings: roots,
      quiet: true,
    };
    const verifyResult = yield* executeCommand(
      ['git', 'rev-parse', '--verify', `${sanitizedCommit}^{commit}`],
      gitOptions,
    );

    if (!verifyResult.success) {
      return null;
    }

    const labelResult = yield* executeCommand(
      ['git', 'show', '-s', `--format=${COMMIT_LABEL_FORMAT}`, sanitizedCommit],
      gitOptions,
    );

    if (!labelResult.success) {
      return sanitizedCommit;
    }

    return labelResult.stdout;
  });
}

function promptInput(
  title: string,
  prompt: string,
  password = false,
): Effect.Effect<string | null, HostPromptFailed> {
  return Effect.gen(function* () {
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
        yield* Effect.forkDetach(
          announce(
            CHANNEL,
            vscodeUi.showWarningMessage('Clone cancelled.'),
            undefined,
          ),
        );
      }
      return null;
    }
    return trimmed;
  });
}

/**
 * Platform-specific package-manager install options surfaced when `git` is
 * missing from PATH. Each option pairs the package-manager binary (used to
 * probe whether the PM is installed) with the full install command.
 */
const GIT_INSTALL_OPTIONS: Partial<
  Record<NodeJS.Platform, { tool: string; command: string }>
> = {
  darwin: { tool: 'brew', command: 'brew install git' },
  win32: { tool: 'winget', command: 'winget install --id Git.Git -e' },
  linux: { tool: 'apt-get', command: 'sudo apt-get install git' },
};

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

const promptGitMissing = Effect.fnUntraced(function* () {
  const option = GIT_INSTALL_OPTIONS[process.platform] ?? null;
  // A PATH lookup, not a spawn: the manager only has to be installed for
  // its install command to be worth offering.
  const command =
    option && (yield* findCommand(option.tool)) !== null
      ? option.command
      : null;

  let message: string;
  if (command) {
    message = `Git not found in PATH. Install it with:\n  ${command}`;
  } else if (option) {
    message = `Git not found in PATH. Install ${option.tool} and run "${option.command}", or download git from ${GIT_DOWNLOAD_URL}.`;
  } else {
    message = `Git not found in PATH. See ${GIT_DOWNLOAD_URL} to install it.`;
  }

  const actions = command
    ? (['Copy Command', 'Run in Terminal', 'Open git-scm.com'] as const)
    : (['Open git-scm.com'] as const);

  yield* Effect.logError(message).pipe(withLogChannel(CHANNEL));
  const selected = yield* announce(
    CHANNEL,
    vscodeUi.error(message, { items: actions }),
    undefined,
  );
  if (selected === 'Copy Command' && command) {
    yield* Effect.tryPromise({
      try: async () => vscode.env.clipboard.writeText(command),
      catch: ensureError,
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
  } else if (selected === 'Open git-scm.com') {
    yield* openUrl(GIT_DOWNLOAD_URL);
  }
});

/** Wire the shared Overleaf/ShareLaTeX clone workflow to the secret store
 *  and VS Code's input prompts and terminal/progress UI. All decision logic
 *  (token validation, precondition checks, auth-failure retry) lives in
 *  `@latex/overleafClone`; this only renders it. */
function buildOverleafClonePorts(
  secrets: PlatformSecrets,
  remote: OverleafRemote,
  workspaceFs: RootedFileSystem,
  spawner: ChildProcessSpawner['Service'],
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
    showInvalidToken: (spec, message) =>
      Effect.logError(message).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(
          announce(
            CHANNEL,
            vscodeUi.error(message, {
              items: spec.tokenHint ? ['How to get a token'] : [],
            }),
            undefined,
          ).pipe(
            Effect.flatMap((action) =>
              action === 'How to get a token'
                ? openUrl(OVERLEAF_TOKEN_DOCS_URL)
                : Effect.void,
            ),
          ),
        ),
      ),

    showGitMissing: () =>
      Effect.provideService(promptGitMissing(), ChildProcessSpawner, spawner),
    listWorkspaceEntries: (workspacePath) =>
      workspaceFs.readDirectory(workspacePath),
    showWorkspaceUnreadable: (e) =>
      Effect.logError(`readDir failed: ${toErrorMessage(e)}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.forkDetach(
            announce(
              CHANNEL,
              vscodeUi.showErrorMessage('Cannot read workspace folder.'),
              undefined,
            ),
          ),
        ),
      ),
    showWorkspaceNotEmpty: () =>
      Effect.forkDetach(
        showLoggedMessage(CHANNEL, 'Workspace folder must be empty.'),
      ).pipe(Effect.asVoid),

    runClone: (clone, workspacePath) =>
      withVSCodeProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX'}…`,
        },
        () => gitClone(clone, workspacePath),
      ),
    showCloneSucceeded: (label) =>
      Effect.forkDetach(
        announce(
          CHANNEL,
          vscodeUi.showInfoMessage(`${label} project cloned.`),
          undefined,
        ),
      ).pipe(Effect.asVoid),
    showAuthFailure: (r) =>
      Effect.gen(function* () {
        const detail = r.isOverleaf
          ? 'Your git token may be invalid or expired.'
          : 'Check your credentials.';
        const selected = yield* announce(
          CHANNEL,
          vscodeUi.error(`Clone failed: authentication error. ${detail}`, {
            items: r.isOverleaf
              ? ['Get New Token', 'How to get a token']
              : ['Retry'],
          }),
          undefined,
        );
        if (selected === 'Get New Token') {
          yield* openUrl(OVERLEAF_GIT_TOKEN_URL);
        } else if (selected === 'How to get a token') {
          yield* openUrl(OVERLEAF_TOKEN_DOCS_URL);
        }
      }),
    showCloneFailed: (message) =>
      Effect.forkDetach(
        announce(CHANNEL, vscodeUi.showErrorMessage(message), undefined),
      ).pipe(Effect.asVoid),
    logCloneError: (message) =>
      Effect.logError(`Clone failed: ${message}`).pipe(withLogChannel(CHANNEL)),
  };
}

export function cloneOverleafProject(secrets: PlatformSecrets) {
  return Effect.gen(function* () {
    const input = yield* promptInput(
      'Clone Overleaf/ShareLaTeX Project',
      'Enter project URL or 24-character project ID.',
    );
    if (!input) return;

    const remote = parseLatexGitUrl(input);
    if (!remote) {
      yield* Effect.forkDetach(
        showLoggedMessage(CHANNEL, 'Invalid project URL or ID.'),
      );
      return;
    }

    // The session's workspace view both names the clone target and lists it,
    // so the emptiness check and the clone agree on one folder. The view is
    // the one the command root provided; this depth only reads it.
    const workspaceFs = yield* WorkspaceFs;
    const workspacePath = workspaceFs.root;
    if (!workspacePath) {
      yield* Effect.forkDetach(
        showLoggedMessage(CHANNEL, 'Open a workspace folder first.'),
      );
      return;
    }
    yield* runOverleafClone(
      remote,
      workspacePath,
      buildOverleafClonePorts(
        secrets,
        remote,
        workspaceFs,
        yield* ChildProcessSpawner,
      ),
    );
  });
}
