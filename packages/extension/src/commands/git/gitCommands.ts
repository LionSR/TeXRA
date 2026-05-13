// Third-party imports
import { execa, execaSync } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { extendEnvPath } from '@utils/system/platformPaths';

const CHANNEL = 'gitCommands';
logger.initialize(CHANNEL);

const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';
const COMMIT_HASH_PATTERN = /^[0-9a-fA-F]{4,40}$/;
const LATEX_PROJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const LATEX_GIT_URL_PATTERN =
  /^https?:\/\/(?:git@)?([^/]+)(\/git)?\/([a-f0-9]{24})$/i;
const LATEX_PROJECT_URL_PATTERN =
  /^https?:\/\/([^/]+)\/project\/([a-f0-9]{24})\/?$/i;
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
  context.subscriptions.push(
    // `isGitRepository`, `getRecentCommits`, and `findCommitInHistory`
    // return values to `executeCommand` callers (sync `boolean`,
    // `string[] | null`, `string | null` respectively) and accept
    // optional positional arguments — they keep their per-command
    // registration. `texra.cloneOverleafProject` migrated through the
    // shared command registry in #3781 batch 3 (see
    // `extensionCommandSurface.ts`).
    vscode.commands.registerCommand(
      gitCommands.isGitRepository,
      isGitRepository,
    ),
    vscode.commands.registerCommand(
      gitCommands.getRecentCommits,
      getRecentCommits,
    ),
    vscode.commands.registerCommand(
      gitCommands.findCommitInHistory,
      findCommitInHistory,
    ),
  );
}

export { cloneOverleafProject };

/**
 * Check if the workspace (or a given path) is inside a git repository.
 *
 * @param rootPath - Optional root path override. Defaults to VS Code workspace.
 *   Pass a worktree path to check a specific checkout.
 */
function isGitRepository(rootPath?: string): boolean {
  const workspacePath = rootPath ?? WorkspaceFS.getPath();
  if (!workspacePath) {
    return false;
  }
  const result = execaSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspacePath,
    reject: false,
  });
  return result.exitCode === 0;
}

function getRecentCommits(rootPath?: string): string[] | null {
  const workspacePath = rootPath ?? WorkspaceFS.getPath();
  if (!workspacePath || !isGitRepository(workspacePath)) {
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

  const result = execaSync(
    'git',
    [
      'log',
      '-n',
      String(numberOfCommits),
      `--pretty=format:${COMMIT_LABEL_FORMAT}`,
    ],
    { cwd: workspacePath, reject: false },
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim());
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

  const verifyResult = execaSync(
    'git',
    ['rev-parse', '--verify', `${sanitizedCommit}^{commit}`],
    { cwd: workspacePath, reject: false },
  );

  if (verifyResult.exitCode !== 0) {
    return null;
  }

  const labelResult = execaSync(
    'git',
    ['show', '-s', `--format=${COMMIT_LABEL_FORMAT}`, sanitizedCommit],
    { cwd: workspacePath, reject: false },
  );

  if (labelResult.exitCode !== 0) {
    return sanitizedCommit;
  }

  const label = labelResult.stdout.trim();
  return label || sanitizedCommit;
}

/**
 * Parse Overleaf or ShareLaTeX URL. Returns null if invalid.
 * Accepts:
 *   - https://git.overleaf.com/<24-char-hex>
 *   - https://sharelatex.example.com/git/<24-char-hex>
 *   - https://git@sharelatex.example.com/git/<24-char-hex>
 *   - https://www.overleaf.com/project/<24-char-hex>
 *   - https://sharelatex.example.com/project/<24-char-hex>
 *   - bare 24-char hex (assumes Overleaf)
 */
function parseLatexGitUrl(
  input: string,
): { host: string; path: string; isOverleaf: boolean } | null {
  const trimmed = input.trim();

  // Full git URL (e.g. https://git.overleaf.com/<id>)
  const match = LATEX_GIT_URL_PATTERN.exec(trimmed);
  if (match) {
    const [, host, hasGit, id] = match;
    return {
      host,
      path: hasGit ? `/git/${id}` : `/${id}`,
      isOverleaf: host === 'git.overleaf.com',
    };
  }

  // Project URL (e.g. https://www.overleaf.com/project/<id> or https://sharelatex.example.com/project/<id>)
  const projectMatch = LATEX_PROJECT_URL_PATTERN.exec(trimmed);
  if (projectMatch) {
    const [, rawHost, id] = projectMatch;
    const host = rawHost.replace(/^www\./, '');
    const isOverleaf = host === 'overleaf.com';
    return {
      host: isOverleaf ? 'git.overleaf.com' : host,
      path: isOverleaf ? `/${id}` : `/git/${id}`,
      isOverleaf,
    };
  }

  // Bare project ID -> Overleaf
  if (LATEX_PROJECT_ID_PATTERN.test(trimmed)) {
    return { host: 'git.overleaf.com', path: `/${trimmed}`, isOverleaf: true };
  }

  return null;
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
): Promise<{ remote: string; sensitive: string[] } | null> {
  const isValid = (t: string): boolean => validate?.(t) ?? true;

  // Try stored token first
  const stored = (await secrets.get(key))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return buildTokenResult(stored);
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
    const action = await vscode.window.showErrorMessage(
      promptHint
        ? `Invalid token format. ${promptHint}`
        : 'Invalid token format.',
      ...(promptHint ? (['How to get a token'] as const) : []),
    );
    if (action === 'How to get a token') {
      void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL));
    }
    return null;
  }

  await secrets.store(key, input);
  return buildTokenResult(input);
}

function buildTokenResult(token: string): {
  remote: string;
  sensitive: string[];
} {
  const encoded = encodeURIComponent(token);
  return { remote: `git:${encoded}`, sensitive: [token, encoded] };
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
  return (
    execaSync(tool, ['--version'], {
      reject: false,
      env: { ...process.env, PATH: extendEnvPath() },
    }).exitCode === 0
  );
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
  if (execaSync('git', ['--version'], { reject: false }).exitCode !== 0) {
    await promptGitMissing();
    return false;
  }

  let entries: [string, number][];
  try {
    entries = await WorkspaceFS.readDir(workspacePath);
  } catch (e) {
    vscode.window.showErrorMessage('Cannot read workspace folder.');
    logger.error(CHANNEL, `readDir failed: ${toErrorMessage(e)}`);
    return false;
  }

  if (entries.some(([name]) => !IGNORED_FILES.has(name))) {
    vscode.window.showErrorMessage('Workspace folder must be empty.');
    return false;
  }

  return true;
}

async function cloneOverleafProject(
  context: vscode.ExtensionContext,
): Promise<void> {
  const input = await promptInput(
    'Clone Overleaf/ShareLaTeX Project',
    'Enter project URL or 24-character project ID.',
  );
  if (!input) return;

  const parsed = parseLatexGitUrl(input);
  if (!parsed) {
    vscode.window.showErrorMessage('Invalid project URL or ID.');
    return;
  }

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const tokenKey = parsed.isOverleaf
    ? 'overleaf.gitToken'
    : `sharelatex.${parsed.host}.token`;
  const tokenTitle = parsed.isOverleaf
    ? 'Overleaf Git Token'
    : `ShareLaTeX Token (${parsed.host})`;
  const tokenValidator = parsed.isOverleaf
    ? (t: string) => t.startsWith('olp_')
    : undefined;
  const tokenHint = parsed.isOverleaf
    ? 'Overleaf tokens start with olp_. Generate one at Account Settings → Git Integration.'
    : undefined;

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

  const remote = `https://${creds.remote}@${parsed.host}${parsed.path}`;
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
          env: { GIT_TERMINAL_PROMPT: '0' },
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
      const selected = await vscode.window.showErrorMessage(
        `Clone failed: authentication error. ${detail}`,
        ...actions,
      );
      if (selected === 'Get New Token') {
        void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_GIT_TOKEN_URL));
      } else if (selected === 'How to get a token') {
        void vscode.env.openExternal(vscode.Uri.parse(OVERLEAF_TOKEN_DOCS_URL));
      }
    } else {
      vscode.window.showErrorMessage(
        'Clone failed. Check credentials and connection.',
      );
    }

    if (e instanceof Error) {
      let msg = e.message;
      for (const s of creds.sensitive) msg = msg.replaceAll(s, '***');
      logger.error(CHANNEL, `Clone failed: ${msg}`);
    }
  }
}
