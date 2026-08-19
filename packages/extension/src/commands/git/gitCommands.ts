// Third-party imports
import { execa } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
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
import { platform } from '@platform/platform';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { COMMIT_HASH_PATTERN } from '@utils/git/commitHashPattern';
import { COMMIT_LABEL_FORMAT } from '@utils/git/commitLogFormat';
import { readRecentCommitLabels } from '@utils/git/repositoryOverview';
import { executeCommandSync } from '@utils/system/execUtils';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import { isGitRepository } from '@utils/git/isGitRepository';

const CHANNEL = 'gitCommands';
const log = createLog(CHANNEL);

export function registerGitCommands(context: vscode.ExtensionContext): void {
  // `isGitRepository`, `getRecentCommits`, and `findCommitInHistory`
  // return values to `executeCommand` callers (`boolean`,
  // `string[] | null`, `string | null` respectively) and accept
  // optional positional arguments — they keep their per-command
  // registration. `texra.cloneOverleafProject` migrated through the
  // shared command registry in #3781 batch 3 (see
  // `extensionCommandSurface.ts`).
  registerCommandEntries(context, [
    { id: 'texra.isGitRepository', handler: isGitRepository },
    { id: 'texra.getRecentCommits', handler: getRecentCommits },
    { id: 'texra.findCommitInHistory', handler: findCommitInHistory },
  ]);
}

async function getRecentCommits(rootPath?: string): Promise<string[] | null> {
  // The probe runs before the config validation so an invalid
  // `numberOfCommitsToShow` in a non-git workspace still answers `null`
  // rather than throwing.
  const workspacePath = rootPath ?? WorkspaceFS.getPath();
  if (!workspacePath || !(await isGitRepository(workspacePath))) {
    return null;
  }

  const numberOfCommits = getConfig('texra.git.numberOfCommitsToShow', 20);
  if (
    typeof numberOfCommits !== 'number' ||
    numberOfCommits <= 0 ||
    numberOfCommits > 1000
  ) {
    throw new Error(
      'Invalid numberOfCommits value. Must be a positive integer between 1 and 1000.',
    );
  }

  const commits = await readRecentCommitLabels(workspacePath, numberOfCommits);
  return commits ?? [];
}

function findCommitInHistory(
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

  const workspacePath = rootPath ?? WorkspaceFS.getPath();
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
    option && executeCommandSync([option.tool, '--version']).success
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
  remote: OverleafRemote,
): OverleafCloneWorkflowPorts {
  const secrets = platform().secrets;
  return {
    // `getStored` (not `get`): the clone token is a persisted credential the
    // user manages here, never an environment override.
    getStoredToken: (key) => secrets.getStored(key),
    deleteStoredToken: (key) => secrets.delete(key),
    storeToken: (key, token) => secrets.set(key, token),
    promptToken: (spec) =>
      promptInput(
        spec.tokenTitle,
        spec.tokenHint ?? 'Enter your Git authentication token.',
        true,
      ),
    showInvalidToken: async (spec, message) => {
      log.error(message);
      const action = await vscode.window.showErrorMessage(
        message,
        ...(spec.tokenHint ? (['How to get a token'] as const) : []),
      );
      if (action === 'How to get a token') {
        void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL));
      }
    },

    isGitAvailable: () => executeCommandSync(['git', '--version']).success,
    showGitMissing: promptGitMissing,
    listWorkspaceEntries: async (workspacePath) =>
      (await WorkspaceFS.readDir(workspacePath)).map(([name]) => name),
    showWorkspaceUnreadable: (e) => {
      log.error(`readDir failed: ${toErrorMessage(e)}`);
      void vscode.window.showErrorMessage('Cannot read workspace folder.');
    },
    showWorkspaceNotEmpty: () => {
      void showLoggedMessage(CHANNEL, 'Workspace folder must be empty.');
    },

    runClone: async (remoteUrl, workspacePath) => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX'}…`,
        },
        () =>
          execa('git', ['clone', remoteUrl, '.'], {
            cwd: workspacePath,
            // Same extended PATH as the executeCommandSync preflight above, so
            // the probe can't pass while the clone misses git (bot review).
            // extendEnv: false is required — makeMachineGitEnv omits the
            // helper-invoking keys, and execa's default merge re-adds them.
            env: makeMachineGitEnv(),
            extendEnv: false,
          }),
      );
    },
    showCloneSucceeded: (label) => {
      vscode.window.showInformationMessage(`${label} project cloned.`);
    },
    showAuthFailure: async (r) => {
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
        void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_GIT_TOKEN_URL));
      } else if (selected === 'How to get a token') {
        void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL));
      }
    },
    showCloneFailed: (message) => {
      void vscode.window.showErrorMessage(message);
    },
    logCloneError: (message) => {
      log.error(`Clone failed: ${message}`);
    },
  };
}

export async function cloneOverleafProject(): Promise<void> {
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

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    void showLoggedMessage(CHANNEL, 'Open a workspace folder first.');
    return;
  }

  await runOverleafClone(
    remote,
    workspacePath,
    buildOverleafClonePorts(remote),
  );
}
