// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import type { SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
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
import { withLogChannel } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { COMMIT_HASH_PATTERN } from '@utils/git/commitHashPattern';
import { COMMIT_LABEL_FORMAT } from '@utils/git/commitLogFormat';
import { executeCommand } from '@utils/system/execUtils';
import { whichOnExtendedPath } from '@utils/system/platformPaths';

const CHANNEL = 'gitCommands';

export function registerGitCommands(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  // `findCommitInHistory` returns its `string | null` to `executeCommand`
  // callers and accepts an optional positional argument, so it keeps its
  // per-command registration.
  registerCommandEntries(context, [
    {
      id: 'texra.findCommitInHistory',
      handler: (commitHash: string, rootPath?: string) =>
        runtime.runPromise(findCommitInHistory(session, commitHash, rootPath)),
    },
  ]);
}

function findCommitInHistory(
  session: SessionHandle,
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

    const workspacePath = rootPath ?? session.roots.workspace;
    if (!workspacePath) {
      return null;
    }

    const gitOptions = {
      cwd: workspacePath,
      settings: session.roots,
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
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const val = yield* Effect.promise(() =>
      vscode.window.showInputBox({
        title,
        prompt,
        password,
        ignoreFocusOut: true,
      }),
    );
    const trimmed = val?.trim() ?? '';
    if (!trimmed) {
      // Show cancellation message only if user dismissed with empty string (not Escape)
      if (val !== undefined) {
        vscode.window.showWarningMessage('Clone cancelled.');
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
    option && whichOnExtendedPath(option.tool) !== null ? option.command : null;

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
  yield* Effect.promise(async () => {
    const selected = await vscode.window.showErrorMessage(message, ...actions);
    if (selected === 'Copy Command' && command) {
      await vscode.env.clipboard.writeText(command);
    } else if (selected === 'Run in Terminal' && command) {
      const terminal = vscode.window.createTerminal('Install Git');
      terminal.show();
      terminal.sendText(command);
    } else if (selected === 'Open git-scm.com') {
      void vscode.env.openExternal(vscode.Uri.parse(GIT_DOWNLOAD_URL));
    }
  });
});

/** Wire the shared Overleaf/ShareLaTeX clone workflow to VS Code's secret
 *  storage, input prompts, and terminal/progress UI. All decision logic
 *  (token validation, precondition checks, auth-failure retry) lives in
 *  `@latex/overleafClone`; this only renders it. */
function buildOverleafClonePorts(
  secrets: PlatformSecrets,
  remote: OverleafRemote,
  workspaceFs: RootedFileSystem,
): OverleafCloneWorkflowPorts {
  return {
    // `orDie` keeps what `Effect.promise` did with a rejected store call: a
    // credential store this host cannot reach is a defect here, not a clone
    // outcome the workflow reports.
    getStoredToken: (key) => Effect.orDie(secrets.get(key)),
    deleteStoredToken: (key) => Effect.orDie(secrets.delete(key)),
    storeToken: (key, token) => Effect.orDie(secrets.set(key, token)),
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
          Effect.promise(async () => {
            const action = await vscode.window.showErrorMessage(
              message,
              ...(spec.tokenHint ? (['How to get a token'] as const) : []),
            );
            if (action === 'How to get a token') {
              void vscode.env.openExternal(
                vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL),
              );
            }
          }),
        ),
      ),

    showGitMissing: () => promptGitMissing(),
    listWorkspaceEntries: (workspacePath) =>
      workspaceFs.readDirectory(workspacePath),
    showWorkspaceUnreadable: (e) =>
      Effect.logError(`readDir failed: ${toErrorMessage(e)}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.sync(() => {
            void vscode.window.showErrorMessage(
              'Cannot read workspace folder.',
            );
          }),
        ),
      ),
    showWorkspaceNotEmpty: () =>
      Effect.forkDetach(
        showLoggedMessage(CHANNEL, 'Workspace folder must be empty.'),
      ).pipe(Effect.asVoid),

    runClone: (clone, workspacePath) =>
      // The notification shows for exactly as long as the clone runs: its
      // task is a promise the release settles on every exit, and the acquire
      // that opens it cannot be interrupted before the release is installed.
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => {
            resolve = settle;
          });
          void vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Cloning ${remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX'}…`,
            },
            () => promise,
          );
          return resolve;
        }),
        () =>
          gitClone(clone, workspacePath).pipe(
            Effect.mapError((error) => new Error(error.message)),
          ),
        (resolve) => Effect.sync(resolve),
      ),
    showCloneSucceeded: (label) =>
      Effect.sync(() => {
        vscode.window.showInformationMessage(`${label} project cloned.`);
      }),
    showAuthFailure: (r) =>
      Effect.promise(async () => {
        const detail = r.isOverleaf
          ? 'Your git token may be invalid or expired.'
          : 'Check your credentials.';
        const actions = r.isOverleaf
          ? (['Get New Token', 'How to get a token'] as const)
          : (['Retry'] as const);
        const authErrorMessage = `Clone failed: authentication error. ${detail}`;
        const selected = await vscode.window.showErrorMessage(
          authErrorMessage,
          ...actions,
        );
        if (selected === 'Get New Token') {
          void vscode.env.openExternal(
            vscode.Uri.parse(OVERLEAF_GIT_TOKEN_URL),
          );
        } else if (selected === 'How to get a token') {
          void vscode.env.openExternal(
            vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL),
          );
        }
      }),
    showCloneFailed: (message) =>
      Effect.sync(() => {
        void vscode.window.showErrorMessage(message);
      }),
    logCloneError: (message) =>
      Effect.logError(`Clone failed: ${message}`).pipe(withLogChannel(CHANNEL)),
  };
}

export function cloneOverleafProject(
  session: SessionHandle,
  secrets: PlatformSecrets,
) {
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
      buildOverleafClonePorts(secrets, remote, workspaceFs),
    );
  });
}
