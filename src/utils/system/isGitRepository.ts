/**
 * Async probe for "is this path inside a git working tree?".
 *
 * VS Code-free: uses the injected WorkspaceFS provider for the default root
 * and shells out via `execFile` so availability checks (e.g. the GitHub
 * PR-subscription gate in EXTERNAL_TOOL_DEFS) can live outside the command
 * layer.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { WorkspaceFS } from '@utils/files';

const execFileAsync = promisify(execFile);

export async function isGitRepository(rootPath?: string): Promise<boolean> {
  const cwd = rootPath ?? WorkspaceFS.getPath();
  if (!cwd) return false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd, timeout: 5_000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
