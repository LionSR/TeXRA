// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getHeadSha, getCurrentRepo, gh, delay } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const POLL_INTERVAL_MS = 30_000;

const InputSchema = z.strictObject({
  repo: z.string().describe('owner/repo. Omit to use current repo.').nullish(),
  issue_number: z
    .number()
    .int()
    .positive()
    .describe('PR or issue number to monitor (for ci/ci_pass/comment modes).')
    .nullish(),
  issues: z
    .array(
      z.strictObject({
        issue_number: z.number().int().positive(),
        wait_for: z.enum(['ci', 'ci_pass', 'comment']),
        workflow: z.string().nullish(),
        from: z.string().nullish(),
        repo: z.string().nullish(),
        ref: z.string().nullish(),
      }),
    )
    .describe(
      'For wait_any: array of targets to monitor concurrently. ' +
        'Returns as soon as ANY target completes.',
    )
    .nullish(),
  ref: z
    .string()
    .describe(
      'Branch to monitor for ci/ci_pass. Omit to use current branch or PR head.',
    )
    .nullish(),
  wait_for: z
    .enum(['ci', 'ci_pass', 'comment', 'wait_any'])
    .describe(
      '"ci" — wait for all GitHub Actions runs to finish (pass or fail). ' +
        '"ci_pass" — wait for all to pass (fail fast on any failure). ' +
        '"comment" — wait for a new comment on the PR or issue. ' +
        '"wait_any" — monitor multiple issues/PRs concurrently; returns when ANY completes. ' +
        'Requires the `issues` array parameter.',
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

export type WaitForGitHubInput = z.infer<typeof InputSchema>;

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

export class WaitForGitHubTool extends defineTool({
  name: 'wait_for_github',
  description:
    'Wait for activity on GitHub PRs or issues. Four modes:\n' +
    '- "ci": wait for all GitHub Actions runs to complete (for PRs or branches)\n' +
    '- "ci_pass": same, but fail fast if any run fails\n' +
    '- "comment": wait for a new comment on a PR or issue (use `from` to filter by author)\n' +
    '- "wait_any": monitor multiple issues/PRs concurrently, return when ANY completes\n' +
    'For @claude: use ci/ci_pass with workflow="claude.yml" (Claude works via GitHub Actions).\n' +
    'For @codex: use comment mode with from="codex[bot]".\n' +
    'For @copilot: use comment mode with from="github-copilot[bot]".\n' +
    'Use wait_any + issues array to fan out to multiple agents and get the first response.\n' +
    'Polls every 30s. Requires `gh` CLI.',
  schema: InputSchema,
}) {
  protected async execute(input: WaitForGitHubInput): Promise<ToolResult> {
    await ensureGhCli();

    if (input.wait_for === 'wait_any') {
      return this.waitForAny(input);
    }
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

  private async waitForActions(input: WaitForGitHubInput): Promise<ToolResult> {
    const repo = input.repo ?? (await getCurrentRepo());

    // Resolve head commit SHA so we only watch runs for the latest push,
    // not stale runs from previous commits on the same branch.
    let headSha: string;
    if (input.issue_number) {
      headSha = (
        await gh([
          'pr',
          'view',
          String(input.issue_number),
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

  private async waitForComment(input: WaitForGitHubInput): Promise<ToolResult> {
    const repo = input.repo ?? (await getCurrentRepo());
    const issueNumber = input.issue_number;
    if (!issueNumber) {
      return {
        output: 'issue_number is required for comment mode.',
        summary: 'Missing issue_number',
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
          issueNumber,
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
            output: `${fresh.length} new comment(s) on ${repo}#${issueNumber}:\n\n${lines.join('\n\n')}`,
            summary: `New comment(s) from ${authors} on #${issueNumber}`,
          };
        }

        return null;
      },
      () => ({
        output: `Timed out waiting for comment${fromLabel} on ${repo}#${issueNumber}.`,
        summary: `Timed out waiting for comment on #${issueNumber}`,
        isError: true,
      }),
    );
  }

  private async fetchCommentsSince(
    repo: string,
    issueNumber: number,
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
      `repos/${repo}/issues/${issueNumber}/comments`,
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

  // ---------------------------------------------------------------------------
  // wait_any mode — race multiple targets
  // ---------------------------------------------------------------------------

  private async waitForAny(input: WaitForGitHubInput): Promise<ToolResult> {
    const issues = input.issues;
    if (!issues || issues.length === 0) {
      return {
        output: 'The `issues` array is required for wait_any mode.',
        summary: 'Missing issues array',
        isError: true,
      };
    }

    const defaultRepo = await getCurrentRepo();
    const since = new Date().toISOString();

    // Build checker functions for each target
    const targets = await Promise.all(
      issues.map(async (target) => {
        const repo = target.repo ?? input.repo ?? defaultRepo;
        const label = `${repo}#${target.issue_number}`;

        if (target.wait_for === 'comment') {
          return {
            label,
            check: async (): Promise<ToolResult | null> => {
              const fresh = await this.fetchCommentsSince(
                repo,
                target.issue_number,
                since,
                target.from,
              );
              if (fresh.length > 0) {
                const lines = fresh.map(
                  (c) =>
                    `--- ${c.user.login} (${c.created_at}) ---\n${c.body}\n${c.html_url}`,
                );
                const authors = [
                  ...new Set(fresh.map((c) => c.user.login)),
                ].join(', ');
                return {
                  output: `[${label}] ${fresh.length} new comment(s):\n\n${lines.join('\n\n')}`,
                  summary: `${authors} responded on ${label} (first of ${issues.length} targets)`,
                };
              }
              return null;
            },
          };
        }

        // ci / ci_pass
        let headSha: string;
        try {
          headSha = (
            await gh([
              'pr',
              'view',
              String(target.issue_number),
              '-R',
              repo,
              '--json',
              'headRefOid',
              '-q',
              '.headRefOid',
            ])
          ).trim();
        } catch {
          headSha = await getHeadSha(target.ref);
        }

        return {
          label,
          check: async (): Promise<ToolResult | null> => {
            const runs = await this.fetchRuns(repo, headSha, target.workflow);
            if (runs.length === 0) return null;

            const running = runs.filter((r) => r.status !== 'completed');
            const failed = runs.filter(
              (r) =>
                r.status === 'completed' &&
                r.conclusion !== 'success' &&
                r.conclusion !== 'skipped',
            );

            if (running.length === 0) {
              const lines = runs.map(
                (r) =>
                  `- ${r.workflowName}: ${r.conclusion ?? r.status} (${r.url})`,
              );
              const allPassed = failed.length === 0;
              return {
                output: `[${label}] ${runs.length} run(s) completed:\n${lines.join('\n')}`,
                summary: allPassed
                  ? `${label} passed (first of ${issues.length} targets)`
                  : `${label} failed (first of ${issues.length} targets)`,
                isError: !allPassed,
              };
            }

            if (target.wait_for === 'ci_pass' && failed.length > 0) {
              return {
                output: `[${label}] Failed early: ${failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(', ')}`,
                summary: `${label} failed (first of ${issues.length} targets)`,
                isError: true,
              };
            }

            return null;
          },
        };
      }),
    );

    // Poll all targets each cycle, return the first one that completes
    const targetLabels = targets.map((t) => t.label).join(', ');

    return this.poll(
      input.timeout_minutes ?? 30,
      async () => {
        for (const target of targets) {
          const result = await target.check();
          if (result) return result;
        }
        return null;
      },
      () => ({
        output: `Timed out waiting for any of: ${targetLabels}`,
        summary: `Timed out waiting for ${targets.length} targets`,
        isError: true,
      }),
    );
  }
}
