// Local imports
import { ToolError } from '@tools/result';
import { delay } from '@utils/core';
import { executeCommand } from '@utils/system/execUtils';

/** Whether we've verified `gh` is on PATH this session. */
let ghVerified = false;

/** Ensure `gh` CLI is available (cached after first successful check). */
export async function ensureGhCli(): Promise<void> {
  if (ghVerified) return;
  const result = await executeCommand(['gh', '--version'], {
    timeout: 5000,
    truncate: true,
  });
  if (!result.success) {
    throw new ToolError(
      'The `gh` CLI is not installed or not on PATH. Install from https://cli.github.com/',
    );
  }
  ghVerified = true;
}

/**
 * Run a gh CLI command and return stdout. Throws ToolError on failure.
 * @param args - Arguments as an array (shell-safe, no injection risk).
 */
export async function gh(
  args: string[],
  timeout = 15_000,
): Promise<string> {
  const result = await executeCommand(['gh', ...args], {
    timeout,
    truncate: false,
  });
  if (!result.success) {
    throw new ToolError(
      `gh ${args[0]} failed: ${result.stderr || result.stdout || 'unknown error'}`,
    );
  }
  return result.stdout ?? '';
}

/** Get the current repo as owner/repo. */
export async function getCurrentRepo(): Promise<string> {
  const out = await gh(
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    10_000,
  );
  const repo = out.trim();
  if (!repo) {
    throw new ToolError(
      'Could not determine current repository. Provide `repo` explicitly.',
    );
  }
  return repo;
}

/** Get the current git branch name. */
export async function getCurrentBranch(): Promise<string> {
  const result = await executeCommand(
    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 5000, truncate: true },
  );
  if (!result.success || !result.stdout?.trim()) {
    throw new ToolError(
      'Could not determine current branch. Provide `ref` explicitly.',
    );
  }
  return result.stdout.trim();
}

/** Re-export delay as the canonical sleep primitive. */
export { delay };
