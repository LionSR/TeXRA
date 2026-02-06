// Standard library imports
import * as os from 'os';

// Third-party imports
import { execa } from 'execa';

// Local imports
import { WorkspaceFS } from '@utils/files';

/** Timeout for git commands in milliseconds. */
const GIT_TIMEOUT_MS = 3000;

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
async function getGitInfo(workspacePath: string): Promise<GitInfo | null> {
  try {
    const opts = {
      cwd: workspacePath,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
    } as const;

    // Check if inside a git repo
    const isRepo = await execa(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      opts,
    );
    if (isRepo.exitCode !== 0) return null;

    // Run branch and status checks in parallel
    const [branchResult, statusResult] = await Promise.all([
      execa('git', ['symbolic-ref', '--short', 'HEAD'], opts),
      execa('git', ['status', '--porcelain'], opts),
    ]);

    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null; // detached HEAD

    const dirty =
      statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

    return { isRepo: true, branch, dirty };
  } catch {
    // git not installed or not on PATH (ENOENT), or timed out
    return null;
  }
}

/**
 * Gather workspace environment information.
 */
async function gatherWorkspaceInfo(): Promise<WorkspaceInfo> {
  const workspacePath = WorkspaceFS.getPath();

  return {
    workspacePath,
    platform: getPlatformLabel(),
    shell: detectShell(),
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    git: workspacePath ? await getGitInfo(workspacePath) : null,
  };
}

/** Escape XML special characters in a string. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Build a formatted workspace info block for system prompt injection.
 *
 * Returns a `<workspace_info>` XML block with key environment details
 * that help the LLM understand the user's workspace context.
 */
export async function buildWorkspaceInfoBlock(): Promise<string> {
  const info = await gatherWorkspaceInfo();

  const lines: string[] = [];

  if (info.workspacePath) {
    lines.push(`Workspace: ${escapeXml(info.workspacePath)}`);
  }

  lines.push(`Platform: ${escapeXml(info.platform)}`);

  if (info.shell) {
    lines.push(`Shell: ${escapeXml(info.shell)}`);
  }

  lines.push(`Date: ${info.date}`);

  if (info.git) {
    const parts = ['Git: yes'];
    if (info.git.branch) {
      parts.push(`branch=${escapeXml(info.git.branch)}`);
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
