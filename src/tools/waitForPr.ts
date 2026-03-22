// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getCurrentBranch, getCurrentRepo, gh, sleep } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const InputSchema = z.strictObject({
  repo: z.string().describe('owner/repo. Omit to use current repo.').nullish(),
  pr_number: z
    .number()
    .int()
    .positive()
    .describe('PR number to monitor.')
    .nullish(),
  ref: z
    .string()
    .describe('Branch to monitor for ci/ci_pass. Omit to use current branch or PR head.')
    .nullish(),
  wait_for: z
    .enum(['ci', 'ci_pass', 'comment'])
    .describe(
      '"ci" — wait for all GitHub Actions runs to finish (pass or fail). ' +
        '"ci_pass" — wait for all to pass (fail fast on any failure). ' +
        '"comment" — wait for a new comment on the PR/issue.',
    ),
  workflow: z
    .string()
    .describe('For ci/ci_pass: filter to a workflow file (e.g. "ci.yml", "claude.yml").')
    .nullish(),
  from: z
    .string()
    .describe('For comment: filter by author (e.g. "claude[bot]", "codex[bot]", "github-copilot[bot]").')
    .nullish(),
  timeout_minutes: z.number().positive().max(60).prefault(30),
});

export type WaitForPrInput = z.infer<typeof InputSchema>;

// ---------------------------------------------------------------------------
// Types for GitHub API responses
// ---------------------------------------------------------------------------

interface RunInfo {
  status: string;
  conclusion: string | null;
  url: string;
  workflowName: string;
}

interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class WaitForPrTool extends defineTool({
  name: 'wait_for_pr',
  description:
    'Wait for activity on a GitHub PR. Three modes:\n' +
    '- "ci": wait for all GitHub Actions runs to complete on the PR branch\n' +
    '- "ci_pass": same, but fail fast if any run fails\n' +
    '- "comment": wait for a new comment (use `from` to filter by author, e.g. "codex[bot]")\n' +
    'For @claude: use ci/ci_pass mode (Claude works via GitHub Actions).\n' +
    'For @codex: use comment mode with from="codex[bot]".\n' +
    'Polls every 30s. Requires `gh` CLI.',
  schema: InputSchema,
}) {
  protected async execute(input: WaitForPrInput): Promise<ToolResult> {
    await ensureGhCli();

    if (input.wait_for === 'comment') {
      return this.waitForComment(input);
    }
    return this.waitForActions(input);
  }

  // ---------------------------------------------------------------------------
  // Actions / Success mode
  // ---------------------------------------------------------------------------

  private async waitForActions(input: WaitForPrInput): Promise<ToolResult> {
    const repo = input.repo ?? (await getCurrentRepo());
    const deadline = Date.now() + (input.timeout_minutes ?? 30) * 60_000;

    let branch: string;
    if (input.pr_number) {
      branch = (
        await gh(
          `pr view ${input.pr_number} -R ${repo} --json headRefName -q .headRefName`,
        )
      ).trim();
    } else {
      branch = input.ref ?? (await getCurrentBranch());
    }

    let lastStatus = '';
    while (Date.now() < deadline) {
      const runs = await this.fetchRuns(repo, branch, input.workflow);

      if (runs.length === 0) {
        lastStatus = 'No runs found yet';
        await sleep(30_000);
        continue;
      }

      const running = runs.filter((r) => r.status !== 'completed');
      const failed = runs.filter(
        (r) =>
          r.status === 'completed' &&
          r.conclusion !== 'success' &&
          r.conclusion !== 'skipped',
      );

      if (running.length === 0) {
        const lines = runs.map(
          (r) => `- ${r.workflowName}: ${r.conclusion ?? r.status} (${r.url})`,
        );
        const allPassed = failed.length === 0;
        return {
          output: `${runs.length} run(s) completed for ${repo}:\n${lines.join('\n')}`,
          summary: allPassed
            ? `All ${runs.length} Actions passed`
            : `${failed.length}/${runs.length} failed`,
          isError: !allPassed,
        };
      }

      if (input.wait_for === 'ci_pass' && failed.length > 0) {
        return {
          output: `Failed early: ${failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(', ')}`,
          summary: `${failed.length} Actions failed`,
          isError: true,
        };
      }

      lastStatus = `${running.length} running, ${runs.length - running.length} done`;
      await sleep(30_000);
    }

    return {
      output: `Timed out (${lastStatus})`,
      summary: 'Timed out',
      isError: true,
    };
  }

  private async fetchRuns(
    repo: string,
    branch: string,
    workflow?: string | null,
  ): Promise<RunInfo[]> {
    const parts = [`run list -R ${repo} --branch ${branch} --limit 20`];
    if (workflow) parts.push(`--workflow ${workflow}`);
    parts.push('--json status,conclusion,url,workflowName');
    const out = await gh(parts.join(' '));
    return JSON.parse(out || '[]') as RunInfo[];
  }

  // ---------------------------------------------------------------------------
  // Comment mode
  // ---------------------------------------------------------------------------

  private async waitForComment(input: WaitForPrInput): Promise<ToolResult> {
    const repo = input.repo ?? (await getCurrentRepo());
    const prNumber = input.pr_number;
    if (!prNumber) {
      return {
        output: 'pr_number is required for comment mode.',
        summary: 'Missing pr_number',
        isError: true,
      };
    }

    const deadline = Date.now() + (input.timeout_minutes ?? 30) * 60_000;

    // Snapshot current comment IDs to detect new ones
    const baseline = new Set(
      (await this.fetchComments(repo, prNumber, input.from)).map((c) => c.id),
    );

    while (Date.now() < deadline) {
      await sleep(30_000);

      const comments = await this.fetchComments(repo, prNumber, input.from);
      const fresh = comments.filter((c) => !baseline.has(c.id));

      if (fresh.length > 0) {
        const lines = fresh.map(
          (c) =>
            `--- ${c.user.login} (${c.created_at}) ---\n${c.body}\n${c.html_url}`,
        );
        const authors = [...new Set(fresh.map((c) => c.user.login))].join(
          ', ',
        );
        return {
          output: `${fresh.length} new comment(s) on ${repo}#${prNumber}:\n\n${lines.join('\n\n')}`,
          summary: `New comment(s) from ${authors} on #${prNumber}`,
        };
      }
    }

    const fromLabel = input.from ? ` from ${input.from}` : '';
    return {
      output: `Timed out waiting for comment${fromLabel} on ${repo}#${prNumber}.`,
      summary: `Timed out waiting for comment on #${prNumber}`,
      isError: true,
    };
  }

  private async fetchComments(
    repo: string,
    prNumber: number,
    from?: string | null,
  ): Promise<Comment[]> {
    const out = await gh(`api repos/${repo}/issues/${prNumber}/comments`);
    let comments: Comment[] = JSON.parse(out || '[]');
    if (from) {
      comments = comments.filter((c) => c.user.login === from);
    }
    return comments;
  }
}
