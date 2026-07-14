// Third-party imports
import { execa } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
import { registerCommands } from '@commands/_shared/registerCommands';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  buildAuthenticatedRemoteUrl,
  buildGitCredential,
  overleafTokenSpec,
  parseLatexGitUrl,
  redactSensitive,
  type GitCredential,
} from '@latex/overleafProject';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  COMMIT_LABEL_FORMAT,
  splitCommitLines,
} from '@utils/git/commitLogFormat';
import { executeCommandSync } from '@utils/system/execUtils';
import { extendEnvPath } from '@utils/system/platformPaths';
import { isGitRepository } from '@utils/system/isGitRepository';

const CHANNEL = 'gitCommands';
logger.initialize(CHANNEL);

const COMMIT_HASH_PATTERN = /^[0-9a-fA-F]{4,40}$/;
const OVERLEAF_GIT_TOKEN_URL = 'https://www.overleaf.com/user/settings';
const OVERLEAF_TOKEN_DOCS_URL =
  'https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens';

export const gitCommands = {
  isGitRepository: 'texra.isGitRepository',
  getRecentCommits: 'texra.getRecentCommits',
  findCommitInHistory: 'texra.findCommitInHistory',
  cloneOverleafProject: 'texra.cloneOverleafProject',
};

export function registerGitCommands(context: vscode.ExtensionContext): void {
  // `isGitRepository`, `getRecentCommits`, and `findCommitInHistory`
  // return values to `executeCommand` callers (`boolean`,
  // `string[] | null`, `string | null` respectively) and accept
  // optional positional arguments — they keep their per-command
  // registration. `texra.cloneOverleafProject` migrated through the
  // shared command registry in #3781 batch 3 (see
  // `extensionCommandSurface.ts`).
  registerCommands(context, [
    { id: gitCommands.isGitRepository, handler: isGitRepository },
    { id: gitCommands.getRecentCommits, handler: getRecentCommits },
    { id: gitCommands.findCommitInHistory, handler: findCommitInHistory },
  ]);
}

async function getRecentCommits(rootPath?: string): Promise<string[] | null> {
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

  const result = executeCommandSync(
    [
      'git',
      'log',
      '-n',
      String(numberOfCommits),
      `--pretty=format:${COMMIT_LABEL_FORMAT}`,
    ],
    { cwd: workspacePath },
  );
  if (!result.success) {
    return [];
  }
  return splitCommitLines(result.stdout ?? '');
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

  return labelResult.stdout ?? sanitizedCommit;
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

async function getGitToken(
  secrets: vscode.SecretStorage,
  key: string,
  title: string,
  validate?: (t: string) => boolean,
  promptHint?: string,
): Promise<GitCredential | null> {
  const isValid = (t: string): boolean => validate?.(t) ?? true;

  // Try stored token first
  const stored = (await secrets.get(key))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return buildGitCredential(stored);
  }

  // Clear invalid stored token
  if (stored) {
    await secrets.delete(key);
  }

  // Prompt for new token
  const input = await promptInput(
    title,
    promptHint ?? 'Enter your Git authentication token.',
    true,
  );
  if (!input) return null;

  if (!isValid(input)) {
    const invalidTokenMessage = promptHint
      ? `Invalid token format. ${promptHint}`
      : 'Invalid token format.';
    logger.error(CHANNEL, invalidTokenMessage);
    const action = await vscode.window.showErrorMessage(
      invalidTokenMessage,
      ...(promptHint ? (['How to get a token'] as const) : []),
    );
    if (action === 'How to get a token') {
      void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL));
    }
    return null;
  }

  await secrets.store(key, input);
  return buildGitCredential(input);
}

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

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

function isToolAvailable(tool: string): boolean {
  return executeCommandSync([tool, '--version']).success;
}

async function promptGitMissing(): Promise<void> {
  const option = GIT_INSTALL_OPTIONS[process.platform] ?? null;
  const command =
    option && isToolAvailable(option.tool) ? option.command : null;

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

  logger.error(CHANNEL, message);
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

async function checkClonePreconditions(
  workspacePath: string,
): Promise<boolean> {
  if (!executeCommandSync(['git', '--version']).success) {
    await promptGitMissing();
    return false;
  }

  let entries: [string, number][];
  try {
    entries = await WorkspaceFS.readDir(workspacePath);
  } catch (e) {
    logger.error(CHANNEL, `readDir failed: ${toErrorMessage(e)}`);
    void vscode.window.showErrorMessage('Cannot read workspace folder.');
    return false;
  }

  if (entries.some(([name]) => !IGNORED_FILES.has(name))) {
    void showLoggedMessage(CHANNEL, 'Workspace folder must be empty.');
    return false;
  }

  return true;
}

export async function cloneOverleafProject(
  context: vscode.ExtensionContext,
): Promise<void> {
  const input = await promptInput(
    'Clone Overleaf/ShareLaTeX Project',
    'Enter project URL or 24-character project ID.',
  );
  if (!input) return;

  const parsed = parseLatexGitUrl(input);
  if (!parsed) {
    void showLoggedMessage(CHANNEL, 'Invalid project URL or ID.');
    return;
  }

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    void showLoggedMessage(CHANNEL, 'Open a workspace folder first.');
    return;
  }

  const { tokenKey, tokenTitle, tokenValidator, tokenHint } =
    overleafTokenSpec(parsed);

  const creds = await getGitToken(
    context.secrets,
    tokenKey,
    tokenTitle,
    tokenValidator,
    tokenHint,
  );
  if (!creds) return;

  const canClone = await checkClonePreconditions(workspacePath);
  if (!canClone) return;

  const remote = buildAuthenticatedRemoteUrl(parsed, creds);
  const label = parsed.isOverleaf ? 'Overleaf' : 'ShareLaTeX';

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cloning ${label}…`,
      },
      () =>
        execa('git', ['clone', remote, '.'], {
          cwd: workspacePath,
          // Same extended PATH as the executeCommandSync preflight above, so
          // the probe can't pass while the clone misses git (bot review).
          env: { GIT_TERMINAL_PROMPT: '0', PATH: extendEnvPath() },
        }),
    );
    vscode.window.showInformationMessage(`${label} project cloned.`);
  } catch (e) {
    const isAuthError =
      e instanceof Error &&
      /auth|401|403|fatal: could not read/i.test(e.message);

    if (isAuthError) {
      // Clear the stored bad token so the user is prompted for a new one next time
      await context.secrets.delete(tokenKey);

      const detail = parsed.isOverleaf
        ? 'Your git token may be invalid or expired.'
        : 'Check your credentials.';
      const actions = parsed.isOverleaf
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
    } else {
      void vscode.window.showErrorMessage(
        'Clone failed. Check credentials and connection.',
      );
    }

    if (e instanceof Error) {
      const msg = redactSensitive(e.message, creds.sensitive);
      logger.error(CHANNEL, `Clone failed: ${msg}`);
    }
  }
}
