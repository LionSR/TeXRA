// Standard library imports
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { execa } from 'execa';

// Local imports
import { escapeTextStrict } from '@shared/utils/xmlEscape';
import { WorkspaceFS } from '@utils/files';
import { listExternalRoots } from '@utils/files/externalRoots';
import { isWSL } from './wslDetect';

/** Timeout for git commands in milliseconds. */
const GIT_TIMEOUT_MS = 3000;

/** Gathered workspace environment information for system prompt injection. */
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

/** Detect the user's default shell basename (e.g., "bash", "zsh", "PowerShell"). */
function detectShell(): string | undefined {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec;
    if (!comspec) return undefined;
    const name = path.basename(comspec).toLowerCase();
    if (name === 'powershell.exe' || name === 'pwsh.exe') return 'PowerShell';
    if (name === 'cmd.exe') return 'cmd';
    return name.replace(/\.exe$/, '');
  }
  const shell = process.env.SHELL;
  return shell ? path.basename(shell) : undefined;
}

/** Get a human-readable platform name. */
function getPlatformLabel(): string {
  switch (process.platform) {
    case 'darwin':
      return `macOS (${os.arch()})`;
    case 'win32':
      return `Windows (${os.arch()})`;
    case 'linux':
      return isWSL() ? `Linux/WSL (${os.arch()})` : `Linux (${os.arch()})`;
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
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
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
 *
 * @param workspacePath - Workspace root path override. Defaults to VS Code workspace.
 */
async function gatherWorkspaceInfo(
  workspacePath?: string,
): Promise<WorkspaceInfo> {
  const wsPath = workspacePath ?? WorkspaceFS.getPath();

  return {
    workspacePath: wsPath,
    platform: getPlatformLabel(),
    shell: detectShell(),
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    git: wsPath ? await getGitInfo(wsPath) : null,
  };
}

/**
 * Build a formatted workspace info block for system prompt injection.
 *
 * Returns a `<workspace_info>` XML block with key environment details
 * that help the LLM understand the user's workspace context.
 *
 * @param workspacePath - Workspace root path override. Defaults to VS Code workspace.
 */
export async function buildWorkspaceInfoBlock(
  workspacePath?: string,
): Promise<string> {
  const info = await gatherWorkspaceInfo(workspacePath);

  const lines: string[] = [];

  if (info.workspacePath) {
    lines.push(`Workspace: ${escapeTextStrict(info.workspacePath)}`);
    lines.push(
      `Bash cwd: already set to the workspace path above; use relative paths directly`,
    );
  }

  lines.push(`Platform: ${escapeTextStrict(info.platform)}`);

  if (info.shell) {
    lines.push(`Shell: ${escapeTextStrict(info.shell)}`);
  }

  lines.push(`Date: ${info.date}`);

  if (info.git) {
    const branchPart = info.git.branch
      ? `branch=${escapeTextStrict(info.git.branch)}`
      : 'detached HEAD';
    const parts = ['Git: yes', branchPart];
    if (info.git.dirty) parts.push('uncommitted changes');
    lines.push(parts.join(', '));
  }

  const externalRoots = listExternalRoots();
  if (externalRoots.length > 0) {
    lines.push('');
    lines.push(
      'Accessible external directories (absolute paths — use read_file, write_file, ls, grep, glob, edit_file):',
    );
    for (const root of externalRoots) {
      const rw = root.writable ? 'writable' : 'read-only';
      lines.push(
        `  ${escapeTextStrict(root.absolutePath)} — ${escapeTextStrict(root.label)} (${rw})`,
      );
    }
  }

  return `\n<workspace_info>\n${lines.join('\n')}\n</workspace_info>`;
}
