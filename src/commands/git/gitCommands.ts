// Third-party imports
import { execa, execaSync } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'gitCommands';
logger.initialize(CHANNEL);

const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';
const COMMIT_HASH_PATTERN = /^[0-9a-fA-F]{4,40}$/;
const LATEX_PROJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const LATEX_GIT_URL_PATTERN =
  /^https?:\/\/(?:git@)?([^/]+)(\/git)?\/([a-f0-9]{24})$/i;

export const gitCommands = {
  isGitRepository: 'texra.isGitRepository',
  getRecentCommits: 'texra.getRecentCommits',
  findCommitInHistory: 'texra.findCommitInHistory',
  cloneOverleafProject: 'texra.cloneOverleafProject',
};

export function registerGitCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
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
    vscode.commands.registerCommand(gitCommands.cloneOverleafProject, () =>
      cloneOverleafProject(context),
    ),
  );
}

function isGitRepository(): boolean {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return false;
  }
  const result = execaSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspacePath,
    reject: false,
  });
  return result.exitCode === 0;
}

function getRecentCommits(): string[] | null {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath || !isGitRepository()) {
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
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim());
}

function findCommitInHistory(commitHash: string): string | null {
  if (typeof commitHash !== 'string') {
    return null;
  }

  const sanitizedCommit = commitHash.trim();
  if (!COMMIT_HASH_PATTERN.test(sanitizedCommit)) {
    return null;
  }

  const workspacePath = WorkspaceFS.getPath();
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

  const label = labelResult.stdout.toString().trim();
  return label || sanitizedCommit;
}

/**
 * Parse Overleaf or ShareLaTeX git URL. Returns null if invalid.
 * Accepts:
 *   - https://git.overleaf.com/<24-char-hex>
 *   - https://sharelatex.example.com/git/<24-char-hex>
 *   - https://git@sharelatex.example.com/git/<24-char-hex>
 *   - bare 24-char hex (assumes Overleaf)
 */
function parseLatexGitUrl(
  input: string,
): { host: string; path: string; isOverleaf: boolean } | null {
  const trimmed = input.trim();

  // Full URL
  const match = LATEX_GIT_URL_PATTERN.exec(trimmed);
  if (match) {
    const [, host, hasGit, id] = match;
    return {
      host,
      path: hasGit ? `/git/${id}` : `/${id}`,
      isOverleaf: host === 'git.overleaf.com',
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
): Promise<{ remote: string; sensitive: string[] } | null> {
  const isValid = (t: string): boolean => validate?.(t) ?? true;

  // Try stored token first
  const stored = (await secrets.get(key))?.trim() ?? '';
  if (stored && isValid(stored)) {
    const encoded = encodeURIComponent(stored);
    return { remote: `git:${encoded}`, sensitive: [stored, encoded] };
  }

  // Clear invalid stored token
  if (stored) {
    await secrets.delete(key);
  }

  // Prompt for new token
  const input = await promptInput(
    title,
    'Enter your Git authentication token.',
    true,
  );
  if (!input) {
    return null;
  }
  if (!isValid(input)) {
    vscode.window.showErrorMessage('Invalid token format.');
    return null;
  }

  await secrets.store(key, input);
  const encoded = encodeURIComponent(input);
  return { remote: `git:${encoded}`, sensitive: [input, encoded] };
}

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

async function checkClonePreconditions(
  workspacePath: string,
): Promise<boolean> {
  if (execaSync('git', ['--version'], { reject: false }).exitCode !== 0) {
    vscode.window.showErrorMessage('Git not found in PATH.');
    return false;
  }

  let entries: [string, vscode.FileType][];
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

  const creds = await getGitToken(
    context.secrets,
    tokenKey,
    tokenTitle,
    tokenValidator,
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
    vscode.window.showErrorMessage(
      'Clone failed. Check credentials and connection.',
    );
    if (e instanceof Error) {
      let msg = e.message;
      for (const s of creds.sensitive) msg = msg.replaceAll(s, '***');
      logger.error(CHANNEL, `Clone failed: ${msg}`);
    }
  }
}
