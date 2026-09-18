// Third-party imports
import { Effect } from 'effect';
import { execa } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
import type { SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  cloneOverleafProject as runOverleafClone,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  parseLatexGitUrl,
  type OverleafRemote,
} from '@latex/overleafProject';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { COMMIT_HASH_PATTERN } from '@utils/git/commitHashPattern';
import { COMMIT_LABEL_FORMAT } from '@utils/git/commitLogFormat';
import { readRecentCommitLabels } from '@utils/git/repositoryOverview';
import { executeCommandSync } from '@utils/system/execUtils';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import { isGitRepository } from '@utils/git/isGitRepository';

const CHANNEL = 'gitCommands';
const log = createLog(CHANNEL);

export function registerGitCommands(
  context: vscode.ExtensionContext,
  session: SessionHandle,
): void {
  // `isGitRepository`, `getRecentCommits`, and `findCommitInHistory`
  // return values to `executeCommand` callers (`boolean`,
  // `string[] | null`, `string | null` respectively) and accept
  // optional positional arguments — they keep their per-command
  // registration. `texra.cloneOverleafProject` migrated through the
  // shared command registry in #3781 batch 3 (see
  // `extensionCommandSurface.ts`).
  registerCommandEntries(context, [
    { id: 'texra.isGitRepository', handler: isGitRepository },
    {
      id: 'texra.getRecentCommits',
      handler: (rootPath?: string) => getRecentCommits(session, rootPath),
    },
    {
      id: 'texra.findCommitInHistory',
      handler: (commitHash: string, rootPath?: string) =>
        findCommitInHistory(session, commitHash, rootPath),
    },
  ]);
}

async function getRecentCommits(
  session: SessionHandle,
  rootPath?: string,
): Promise<string[] | null> {
  const workspacePath = rootPath ?? session.roots.workspace;
  if (!workspacePath || !(await isGitRepository(workspacePath))) {
    return null;
  }

  // The catalog row owns the range and the default: a corrupt persisted value
  // warns once through readSetting and resolves to 20 instead of throwing.
  const numberOfCommits = readSettingFrom<number>(
    session.roots,
    'texra.git.numberOfCommitsToShow',
  );

  const commits = await readRecentCommitLabels(workspacePath, numberOfCommits, {
    // A failed `git log` comes back as undefined and is answered as an empty
    // list; without this hook that failure would be invisible in this host
    // (the desktop host passes its own onError to the same read).
    onError: (error) =>
      log.warn(`recent commit read failed: ${toErrorMessage(error)}`),
  });
  return commits ?? [];
}

function findCommitInHistory(
  session: SessionHandle,
  commitHash: string,
  rootPath?: string,
): string | null {
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

  const verifyResult = executeCommandSync(
    ['git', 'rev-parse', '--verify', `${sanitizedCommit}^{commit}`],
    { cwd: workspacePath },
  );

  if (!verifyResult.success) {
    return null;
  }

  const labelResult = executeCommandSync(
    ['git', 'show', '-s', `--format=${COMMIT_LABEL_FORMAT}`, sanitizedCommit],
    { cwd: workspacePath },
  );

  if (!labelResult.success) {
    return sanitizedCommit;
  }

  return labelResult.stdout;
}

async function promptInput(
  title: string,
  prompt: string,
  password = false,
): Promise<string | null> {
  const val = await vscode.window.showInputBox({
    title,
    prompt,
    password,
    ignoreFocusOut: true,
  });
  const trimmed = val?.trim() ?? '';
  if (!trimmed) {
    // Show cancellation message only if user dismissed with empty string (not Escape)
    if (val !== undefined) {
      vscode.window.showWarningMessage('Clone cancelled.');
    }
    return null;
  }
  return trimmed;
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

async function promptGitMissing(): Promise<void> {
  const option = GIT_INSTALL_OPTIONS[process.platform] ?? null;
  const command =
    option &&
    // A `--version` probe is directory-independent; name the process cwd
    // rather than the workspace root it does not read.
    executeCommandSync([option.tool, '--version'], { cwd: process.cwd() })
      .success
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

  log.error(message);
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
}

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
    // `getStored` (not `get`): the clone token is a persisted credential the
    // user manages here, never an environment override.
    // `orDie` keeps what `Effect.promise` did with a rejected store call: a
    // credential store this host cannot reach is a defect here, not a clone
    // outcome the workflow reports.
    getStoredToken: (key) => Effect.orDie(secrets.getStored(key)),
    deleteStoredToken: (key) => Effect.orDie(secrets.delete(key)),
    storeToken: (key, token) => Effect.orDie(secrets.set(key, token)),
    promptToken: (spec) =>
      Effect.promise(() =>
        promptInput(
          spec.tokenTitle,
          spec.tokenHint ?? 'Enter your Git authentication token.',
          true,
        ),
      ),
    showInvalidToken: (spec, message) =>
      Effect.promise(async () => {
        log.error(message);
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

    isGitAvailable: () =>
      Effect.sync(
        // Directory-independent probe: see `promptGitMissing`.
        () =>
          executeCommandSync(['git', '--version'], { cwd: process.cwd() })
            .success,
      ),
    showGitMissing: () => Effect.promise(() => promptGitMissing()),
    listWorkspaceEntries: (workspacePath) =>
      workspaceFs.readDirectory(workspacePath),
    showWorkspaceUnreadable: (e) =>
      Effect.sync(() => {
        log.error(`readDir failed: ${toErrorMessage(e)}`);
        void vscode.window.showErrorMessage('Cannot read workspace folder.');
      }),
    showWorkspaceNotEmpty: () =>
      Effect.sync(() => {
        void showLoggedMessage(CHANNEL, 'Workspace folder must be empty.');
      }),

    runClone: (remoteUrl, workspacePath) =>
      Effect.tryPromise({
        try: (signal) =>
          vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Cloning ${remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX'}…`,
            },
            () => {
              // execa starts its child before observing an already-aborted
              // cancelSignal, so do not enter it after the fiber is interrupted.
              signal.throwIfAborted();
              return execa('git', ['clone', remoteUrl, '.'], {
                cwd: workspacePath,
                // Same extended PATH as the executeCommandSync preflight
                // above, so the probe can't pass while the clone misses git
                // (bot review). extendEnv: false is required —
                // makeMachineGitEnv omits the helper-invoking keys, and
                // execa's default merge re-adds them.
                env: makeMachineGitEnv(),
                extendEnv: false,
                cancelSignal: signal,
              });
            },
          ),
        catch: ensureError,
      }).pipe(Effect.asVoid),
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
      Effect.sync(() => {
        log.error(`Clone failed: ${message}`);
      }),
  };
}

export async function cloneOverleafProject(
  session: SessionHandle,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
): Promise<void> {
  const input = await promptInput(
    'Clone Overleaf/ShareLaTeX Project',
    'Enter project URL or 24-character project ID.',
  );
  if (!input) return;

  const remote = parseLatexGitUrl(input);
  if (!remote) {
    void showLoggedMessage(CHANNEL, 'Invalid project URL or ID.');
    return;
  }

  // The session's workspace view both names the clone target and lists it,
  // so the emptiness check and the clone agree on one folder.
  await runtime.runPromise(
    withSessionFs(
      session.roots,
      Effect.gen(function* () {
        const workspaceFs = yield* WorkspaceFs;
        const workspacePath = workspaceFs.root;
        if (!workspacePath) {
          yield* Effect.sync(
            () =>
              void showLoggedMessage(CHANNEL, 'Open a workspace folder first.'),
          );
          return;
        }
        yield* runOverleafClone(
          remote,
          workspacePath,
          buildOverleafClonePorts(secrets, remote, workspaceFs),
        );
      }),
    ),
  );
}
