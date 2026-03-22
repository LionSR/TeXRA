// Local imports
import { ToolError } from '@tools/result';
import { executeCommand } from '@utils/system/execUtils';

/** Run a gh CLI command and return stdout. Throws ToolError on failure. */
export async function gh(args: string, timeout = 15_000): Promise<string> {
  const result = await executeCommand(`gh ${args}`, {
    timeout,
    truncate: false,
  });
  if (!result.success) {
    throw new ToolError(
      `gh ${args.split(' ')[0]} failed: ${result.stderr || result.stdout || 'unknown error'}`,
    );
  }
  return result.stdout ?? '';
}

/** Verify gh CLI is available. */
export async function ensureGhCli(): Promise<void> {
  const result = await executeCommand('gh --version', {
    timeout: 5000,
    truncate: true,
  });
  if (!result.success) {
    throw new ToolError(
      'The `gh` CLI is not installed or not on PATH. Install from https://cli.github.com/',
    );
  }
}

/** Get the current repo as owner/repo. */
export async function getCurrentRepo(): Promise<string> {
  const out = await gh('repo view --json nameWithOwner -q .nameWithOwner', 10_000);
  const repo = out.trim();
  if (!repo) {
    throw new ToolError('Could not determine current repository. Provide `repo` explicitly.');
  }
  return repo;
}

/** Get the current git branch name. */
export async function getCurrentBranch(): Promise<string> {
  const result = await executeCommand('git rev-parse --abbrev-ref HEAD', {
    timeout: 5000,
    truncate: true,
  });
  if (!result.success || !result.stdout?.trim()) {
    throw new ToolError('Could not determine current branch. Provide `ref` explicitly.');
  }
  return result.stdout.trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
