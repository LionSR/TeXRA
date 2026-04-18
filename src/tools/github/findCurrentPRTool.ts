/**
 * Discover the pull request associated with the current git branch.
 *
 * Runs `git remote -v` + `git rev-parse --abbrev-ref HEAD` in the working
 * directory, infers `owner/repo` from the origin URL, and queries GitHub for
 * a matching open PR. Returns `{ owner, repo, pullNumber }` on success — the
 * same shape `subscribe_pr_activity` takes as input.
 *
 * Exists so an agent asked to "watch this PR" can do so without the user
 * supplying owner/repo/number by hand.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { toErrorMessage } from '@common/errors';
import { ToolError, type ToolResult } from '@tools/result';
import { parseWorkingDirectory } from '@tools/utils';

import { defineTool } from '../core/define';
import { ghGet } from './githubClient';
import { getGitHubToken } from './githubAuth';
import type { GhPullRequest } from './prTypes';

const execFileAsync = promisify(execFile);

const FindCurrentPRInputSchema = z.strictObject({
  working_directory: z
    .string()
    .nullish()
    .describe(
      'Absolute path to run git commands in. Defaults to the agent working directory.',
    ),
});

type FindCurrentPRInput = z.infer<typeof FindCurrentPRInputSchema>;

// GitHub SSH/HTTPS URL → { owner, repo }. Handles `.git` suffix, and repo
// names that themselves contain dots (e.g. `org.github.io`, `my.config`).
const GITHUB_URL_RE =
  /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/;

function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const m = remoteUrl.trim().match(GITHUB_URL_RE);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

async function run(
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export class FindCurrentPRTool extends defineTool({
  name: 'find_current_pr',
  description: [
    'Resolve the GitHub pull request number for the current branch in a local git checkout.',
    'Returns the owner, repo, pullNumber and URL — pass the first three to subscribe_pr_activity.',
    'Fails if the branch has no associated open PR on github.com, the remote is not GitHub, or no GitHub token is configured.',
  ].join(' '),
  schema: FindCurrentPRInputSchema,
}) {
  protected async execute(input: FindCurrentPRInput): Promise<ToolResult> {
    if (!getGitHubToken()) {
      throw new ToolError(
        'No GitHub token configured. Open TeXRA settings → Git tab → "Set token" (or export GITHUB_TOKEN). Needs `repo` scope for private PRs, `public_repo` for public.',
      );
    }
    const cwd =
      parseWorkingDirectory(input.working_directory) ??
      getCurrentToolFileInteractionContext()?.workingDirectory;
    if (!cwd) {
      throw new ToolError(
        'No working_directory available. Provide one explicitly.',
      );
    }

    let remoteUrl: string;
    let branch: string;
    try {
      remoteUrl = await run(['remote', 'get-url', 'origin'], cwd);
      branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    } catch (err) {
      throw new ToolError(
        `git invocation failed in ${cwd}: ${toErrorMessage(err)}`,
      );
    }

    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) {
      throw new ToolError(
        `origin remote is not a github.com URL: ${remoteUrl}`,
      );
    }
    if (branch === 'HEAD') {
      throw new ToolError('HEAD is detached — cannot infer a PR branch.');
    }

    // Query GitHub for an open PR whose head matches owner:branch.
    const path = `/repos/${remote.owner}/${remote.repo}/pulls?state=open&head=${remote.owner}:${encodeURIComponent(branch)}&per_page=1`;
    const res = await ghGet<Array<{ number: number; html_url: string } & Partial<GhPullRequest>>>(path);
    if (res.status !== 200) {
      throw new ToolError(`Unexpected GitHub response status: ${res.status}`);
    }
    const pr = res.data[0];
    if (!pr) {
      throw new ToolError(
        `No open PR found for ${remote.owner}/${remote.repo} head ${branch}. Push the branch and open a PR first.`,
      );
    }

    return {
      summary: `${remote.owner}/${remote.repo}#${pr.number}`,
      output:
        `owner: ${remote.owner}\n` +
        `repo: ${remote.repo}\n` +
        `pullNumber: ${pr.number}\n` +
        `url: ${pr.html_url}`,
    };
  }
}
