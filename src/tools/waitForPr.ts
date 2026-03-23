// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getHeadSha, getCurrentRepo, gh, delay } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const POLL_INTERVAL_MS = 30_000;

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
    .describe(
      'Branch to monitor for ci/ci_pass. Omit to use current branch or PR head.',
    )
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
    .describe(
      'For ci/ci_pass: filter to a workflow file (e.g. "ci.yml", "claude.yml").',
    )
    .nullish(),
  from: z
    .string()
    .describe(
      'For comment: filter by author (e.g. "claude[bot]", "codex[bot]", "github-copilot[bot]").',
    )
    .nullish(),
  timeout_minutes: z.number().positive().max(60).prefault(30),
});

export type WaitForPrInput = z.infer<typeof InputSchema>;

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
  // Shared polling
  // ---------------------------------------------------------------------------

  /**
   * Poll until `check` returns a ToolResult or the deadline is reached.
   * Returns the ToolResult from `check`, or the timeout result.
   */
  private async poll(
    timeoutMinutes: number,
    check: () => Promise<ToolResult | null>,
    timeoutResult: () => ToolResult,
  ): Promise<ToolResult> {
    const deadline = Date.now() + (timeoutMinutes ?? 30) * 60_000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await delay(POLL_INTERVAL_MS);
    }
    return timeoutResult();
  }

  // ---------------------------------------------------------------------------
  // CI mode
  // ---------------------------------------------------------------------------

  private async waitForActions(input: WaitForPrInput): Promise<ToolResult> {
    const repo = input.repo ?? (await getCurrentRepo());

    // Resolve head commit SHA so we only watch runs for the latest push,
    // not stale runs from previous commits on the same branch.
    let headSha: string;
    if (input.pr_number) {
      headSha = (
        await gh([
          'pr',
          'view',
          String(input.pr_number),
          '-R',
          repo,
          '--json',
          'headRefOid',
          '-q',
          '.headRefOid',
        ])
      ).trim();
    } else {
      headSha = await getHeadSha(input.ref);
    }

    let lastStatus = '';

    return this.poll(
      input.timeout_minutes ?? 30,
      async () => {
        const runs = await this.fetchRuns(repo, headSha, input.workflow);

        if (runs.length === 0) {
          lastStatus = 'No runs found yet';
          return null;
        }

        const running = runs.filter((r) => r.status !== 'completed');
        const failed = runs.filter(
          (r) =>
            r.status === 'completed' &&
            r.conclusion !== 'success' &&
            r.conclusion !== 'skipped',
        );

        // All done
        if (running.length === 0) {
          const lines = runs.map(
            (r) =>
              `- ${r.workflowName}: ${r.conclusion ?? r.status} (${r.url})`,
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

        // Fail fast
        if (input.wait_for === 'ci_pass' && failed.length > 0) {
          return {
            output: `Failed early: ${failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(', ')}`,
            summary: `${failed.length} Actions failed`,
            isError: true,
          };
        }

        lastStatus = `${running.length} running, ${runs.length - running.length} done`;
        return null;
      },
      () => ({
        output: `Timed out (${lastStatus})`,
        summary: 'Timed out',
        isError: true,
      }),
    );
  }

  private async fetchRuns(
    repo: string,
    commitSha: string,
    workflow?: string | null,
  ): Promise<RunInfo[]> {
    const args = [
      'run',
      'list',
      '-R',
      repo,
      '--commit',
      commitSha,
      '--limit',
      '20',
    ];
    if (workflow) args.push('--workflow', workflow);
    args.push('--json', 'status,conclusion,url,workflowName');
    const out = await gh(args);
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

    // Use timestamp-based filtering: only fetch comments posted after now
    const since = new Date().toISOString();
    const fromLabel = input.from ? ` from ${input.from}` : '';

    return this.poll(
      input.timeout_minutes ?? 30,
      async () => {
        const fresh = await this.fetchCommentsSince(
          repo,
          prNumber,
          since,
          input.from,
        );

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

        return null;
      },
      () => ({
        output: `Timed out waiting for comment${fromLabel} on ${repo}#${prNumber}.`,
        summary: `Timed out waiting for comment on #${prNumber}`,
        isError: true,
      }),
    );
  }

  private async fetchCommentsSince(
    repo: string,
    prNumber: number,
    since: string,
    from?: string | null,
  ): Promise<Comment[]> {
    // GitHub's `since` param filters by updated_at, not created_at.
    // We pass it to reduce payload size, then filter by created_at
    // client-side to avoid false positives from edited old comments.
    const out = await gh([
      'api',
      '--method',
      'GET',
      `repos/${repo}/issues/${prNumber}/comments`,
      '-f',
      `since=${since}`,
    ]);
    let comments: Comment[] = JSON.parse(out || '[]');
    comments = comments.filter((c) => c.created_at >= since);
    if (from) {
      comments = comments.filter((c) => c.user.login === from);
    }
    return comments;
  }
}
