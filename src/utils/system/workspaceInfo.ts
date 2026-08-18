// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Local imports
import { escapeTextStrict } from '@shared/utils/xmlEscape';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { listExternalRoots } from '@utils/files/externalRoots';
import { isoDateOnly } from '@utils/text/stringUtils';
import { executeCommand } from '@utils/system/execUtils';
import { IS_WINDOWS } from './platformPaths';
import { isWSL } from './wslDetect';

/** Timeout for git commands in milliseconds. */
const GIT_TIMEOUT_MS = 3000;

interface GitInfo {
  branch: string | null;
  dirty: boolean;
}

/** Detect the user's default shell basename (e.g., "bash", "zsh", "PowerShell"). */
function detectShell(): string | undefined {
  if (IS_WINDOWS) {
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
  let base: string;
  switch (process.platform) {
    case 'darwin':
      base = 'macOS';
      break;
    case 'win32':
      base = 'Windows';
      break;
    case 'linux':
      base = isWSL ? 'Linux/WSL' : 'Linux';
      break;
    default:
      base = process.platform;
  }
  return `${base} (${os.arch()})`;
}

/**
 * Gather git repository information for the workspace.
 * Returns null if the workspace is not a git repo or git is unavailable.
 */
async function getGitInfo(workspacePath: string): Promise<GitInfo | null> {
  const opts = { cwd: workspacePath, timeout: GIT_TIMEOUT_MS } as const;

  // Deliberately not isGitRepository(): that also requires stdout === 'true',
  // which excludes bare repos and paths inside .git, where `git rev-parse`
  // exits 0 but prints false. Those still have a usable branch and history, so
  // gate on exit status only and let the branch/status calls below decide.
  const insideWorkTree = await executeCommand(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    opts,
  );
  if (!insideWorkTree.success) return null;

  // Run branch and status checks in parallel
  const [branchResult, statusResult] = await Promise.all([
    executeCommand(['git', 'symbolic-ref', '--short', 'HEAD'], opts),
    executeCommand(['git', 'status', '--porcelain'], opts),
  ]);

  // Unlike a non-zero exit (e.g. detached HEAD), a timeout means we couldn't
  // determine dirty/branch state at all — report unknown (null) rather than
  // silently defaulting `dirty` to false, which would misreport a repo as
  // clean when `git status` merely timed out.
  if (branchResult.timedOut || statusResult.timedOut) return null;

  const branch = branchResult.success ? branchResult.stdout : null;
  // execUtils normalizes empty/whitespace-only output to the empty string
  // (see the ExecResult.stdout contract in src/shared/schemas/opResults.ts),
  // so a clean `git status --porcelain` yields an empty string and that
  // test is what distinguishes clean from dirty.
  const dirty = statusResult.success && statusResult.stdout !== '';

  return { branch, dirty };
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
  const wsPath = workspacePath ?? WorkspaceFS.getPath();
  const platform = getPlatformLabel();
  const shell = detectShell();
  const date = isoDateOnly();
  const git = wsPath ? await getGitInfo(wsPath) : null;

  const lines: string[] = [];

  if (wsPath) {
    lines.push(`Workspace: ${escapeTextStrict(wsPath)}`);
    lines.push(
      `Bash cwd: already set to the workspace path above; use relative paths directly`,
    );
  }

  lines.push(`Platform: ${escapeTextStrict(platform)}`);

  if (shell) {
    lines.push(`Shell: ${escapeTextStrict(shell)}`);
  }

  lines.push(`Date: ${date}`);

  if (git) {
    const branchPart = git.branch
      ? `branch=${escapeTextStrict(git.branch)}`
      : 'detached HEAD';
    const parts = ['Git: yes', branchPart];
    if (git.dirty) parts.push('uncommitted changes');
    lines.push(parts.join(', '));
  } else if (wsPath) {
    lines.push(
      'Git: no repository detected or git could not be checked for this workspace; avoid git history/status checks unless you first confirm a repository exists.',
    );
  }

  const externalRoots = listExternalRoots();
  if (externalRoots.length > 0) {
    lines.push('');
    lines.push(
      'Accessible external directories (absolute paths; use read_file, write_file, grep, glob, edit_file):',
    );
    for (const root of externalRoots) {
      const rw = root.writable ? 'writable' : 'read-only';
      lines.push(
        `  ${escapeTextStrict(root.absolutePath)}: ${escapeTextStrict(root.label)} (${rw})`,
      );
    }
  }

  return `\n<workspace_info>\n${lines.join('\n')}\n</workspace_info>`;
}
