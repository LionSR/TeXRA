// Standard library imports
import * as os from 'os';

// Third-party imports
import { execaSync } from 'execa';

// Local imports
import { WorkspaceFS } from '@utils/files';

/**
 * Gathered workspace environment information for system prompt injection.
 */
interface WorkspaceInfo {
  workspacePath: string | undefined;
  platform: string;
  shell: string | undefined;
  date: string;
  git: GitInfo | null;
}

interface GitInfo {
  isRepo: true;
  branch: string | null;
  dirty: boolean;
}

/**
 * Detect the user's default shell from environment.
 * Returns the shell basename (e.g., "bash", "zsh", "fish") or undefined.
 */
function detectShell(): string | undefined {
  if (process.platform === 'win32') {
    // On Windows, check for common shells
    const comspec = process.env.ComSpec;
    if (comspec) {
      const name = comspec.split(/[\\/]/).pop()?.toLowerCase();
      if (name === 'powershell.exe' || name === 'pwsh.exe') return 'PowerShell';
      if (name === 'cmd.exe') return 'cmd';
      return name?.replace(/\.exe$/, '');
    }
    return undefined;
  }

  // Unix: SHELL env var is the login shell
  const shell = process.env.SHELL;
  if (!shell) return undefined;
  return shell.split('/').pop(); // "bash", "zsh", "fish", etc.
}

/**
 * Get a human-readable platform name.
 */
function getPlatformLabel(): string {
  switch (process.platform) {
    case 'darwin':
      return `macOS (${os.arch()})`;
    case 'win32':
      return `Windows (${os.arch()})`;
    case 'linux':
      return `Linux (${os.arch()})`;
    default:
      return `${process.platform} (${os.arch()})`;
  }
}

/**
 * Gather git repository information for the workspace.
 * Returns null if the workspace is not a git repo or git is unavailable.
 */
function getGitInfo(workspacePath: string): GitInfo | null {
  // Check if inside a git repo
  const isRepo = execaSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspacePath,
    reject: false,
  });
  if (isRepo.exitCode !== 0) return null;

  // Get current branch
  const branchResult = execaSync(
    'git',
    ['symbolic-ref', '--short', 'HEAD'],
    { cwd: workspacePath, reject: false },
  );
  const branch =
    branchResult.exitCode === 0
      ? branchResult.stdout.toString().trim()
      : null; // detached HEAD

  // Check for uncommitted changes
  const statusResult = execaSync('git', ['status', '--porcelain'], {
    cwd: workspacePath,
    reject: false,
  });
  const dirty =
    statusResult.exitCode === 0 &&
    statusResult.stdout.toString().trim().length > 0;

  return { isRepo: true, branch, dirty };
}

/**
 * Gather workspace environment information.
 * All operations are lightweight and synchronous.
 */
function gatherWorkspaceInfo(): WorkspaceInfo {
  const workspacePath = WorkspaceFS.getPath();

  return {
    workspacePath,
    platform: getPlatformLabel(),
    shell: detectShell(),
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    git: workspacePath ? getGitInfo(workspacePath) : null,
  };
}

/**
 * Build a formatted workspace info block for system prompt injection.
 *
 * Returns a `<workspace_info>` XML block with key environment details
 * that help the LLM understand the user's workspace context.
 */
export function buildWorkspaceInfoBlock(): string {
  const info = gatherWorkspaceInfo();

  const lines: string[] = [];

  if (info.workspacePath) {
    lines.push(`Workspace: ${info.workspacePath}`);
  }

  lines.push(`Platform: ${info.platform}`);

  if (info.shell) {
    lines.push(`Shell: ${info.shell}`);
  }

  lines.push(`Date: ${info.date}`);

  if (info.git) {
    const parts = ['Git: yes'];
    if (info.git.branch) {
      parts.push(`branch=${info.git.branch}`);
    } else {
      parts.push('detached HEAD');
    }
    if (info.git.dirty) {
      parts.push('uncommitted changes');
    }
    lines.push(parts.join(', '));
  }

  return `\n<workspace_info>\n${lines.join('\n')}\n</workspace_info>`;
}
