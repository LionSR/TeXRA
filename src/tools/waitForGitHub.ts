// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getHeadSha, getCurrentRepo, gh, delay } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const POLL_INTERVAL_MS = 30_000;

const TargetSchema = z.strictObject({
  issue_number: z
    .number()
    .int()
    .positive()
    .describe('PR or issue number to monitor.'),
  wait_for: z
    .enum(['ci', 'ci_pass', 'comment'])
    .describe(
      '"ci" — wait for all GitHub Actions runs to finish (pass or fail). ' +
        '"ci_pass" — wait for all to pass (fail fast on any failure). ' +
        '"comment" — wait for a new comment on the PR or issue.',
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
  repo: z.string().describe('owner/repo override for this target.').nullish(),
  ref: z
    .string()
    .describe('Branch override for ci/ci_pass on this target.')
    .nullish(),
});

const InputSchema = z.strictObject({
  repo: z
    .string()
    .describe('Default owner/repo. Omit to use current repo.')
    .nullish(),
  targets: z
    .array(TargetSchema)
    .min(1)
    .describe(
      'One or more targets to monitor. Each specifies a PR/issue and what to wait for.\n' +
        'For @claude: { issue_number: 42, wait_for: "ci", workflow: "claude.yml" }\n' +
        'For @codex: { issue_number: 42, wait_for: "comment", from: "codex[bot]" }\n' +
        'For @copilot: { issue_number: 42, wait_for: "comment", from: "github-copilot[bot]" }',
    ),
  race: z
    .boolean()
    .describe(
      'When true, return as soon as ANY target completes (useful for fan-out to multiple agents). ' +
        'When false, wait for ALL targets to complete. Default: true for multiple targets, always true for single.',
    )
    .prefault(true),
  timeout_minutes: z.number().positive().max(60).prefault(30),
});

export type WaitForGitHubInput = z.infer<typeof InputSchema>;
type Target = z.infer<typeof TargetSchema>;

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
    'Wait for activity on GitHub PRs or issues.\n' +
    'Pass one or more targets, each with a wait_for mode (ci, ci_pass, or comment).\n' +
    'Single target: waits for that target. Multiple targets: returns when the first completes (race=true) or all complete (race=false).\n' +
    'For @claude: use ci/ci_pass with workflow="claude.yml" (Claude works via GitHub Actions).\n' +
    'For @codex: use comment mode with from="codex[bot]".\n' +
    'For @copilot: use comment mode with from="github-copilot[bot]".\n' +
    'Polls every 30s. Requires `gh` CLI.',
  schema: InputSchema,
}) {
  protected async execute(input: WaitForGitHubInput): Promise<ToolResult> {
    await ensureGhCli();

    const defaultRepo = input.repo ?? (await getCurrentRepo());
    const since = new Date().toISOString();
    const race = input.race ?? true;

    // Build a checker for each target
    const checkers = await Promise.all(
      input.targets.map((target) =>
        this.buildChecker(target, defaultRepo, since),
      ),
    );

    if (race || checkers.length === 1) {
      return this.pollRace(checkers, input.timeout_minutes ?? 30);
    }
    return this.pollAll(checkers, input.timeout_minutes ?? 30);
  }

  // ---------------------------------------------------------------------------
  // Checker construction
  // ---------------------------------------------------------------------------

  private async buildChecker(
    target: Target,
    defaultRepo: string,
    since: string,
  ): Promise<{ label: string; check: () => Promise<ToolResult | null> }> {
    const repo = target.repo ?? defaultRepo;
    const label = `${repo}#${target.issue_number}`;

    if (target.wait_for === 'comment') {
      return {
        label,
        check: () =>
          this.checkComment(repo, target.issue_number, since, target.from),
      };
    }

    // ci / ci_pass — resolve HEAD SHA once
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

    const waitFor = target.wait_for as 'ci' | 'ci_pass';
    return {
      label,
      check: () => this.checkActions(repo, headSha, target.workflow, waitFor),
    };
  }

  // ---------------------------------------------------------------------------
  // Polling strategies
  // ---------------------------------------------------------------------------

  /** Return the first completed result (race semantics). */
  private async pollRace(
    checkers: { label: string; check: () => Promise<ToolResult | null> }[],
    timeoutMinutes: number,
  ): Promise<ToolResult> {
    const labels = checkers.map((c) => c.label).join(', ');
    const deadline = Date.now() + timeoutMinutes * 60_000;

    while (Date.now() < deadline) {
      for (const checker of checkers) {
        const result = await checker.check();
        if (result) {
          if (checkers.length > 1) {
            result.summary = `${result.summary} (first of ${checkers.length})`;
          }
          return result;
        }
      }
      await delay(POLL_INTERVAL_MS);
    }

    return {
      output: `Timed out waiting for: ${labels}`,
      summary: `Timed out (${checkers.length} target${checkers.length > 1 ? 's' : ''})`,
      isError: true,
    };
  }

  /** Wait for ALL checkers to complete, collecting results. */
  private async pollAll(
    checkers: { label: string; check: () => Promise<ToolResult | null> }[],
    timeoutMinutes: number,
  ): Promise<ToolResult> {
    const results = new Map<string, ToolResult>();
    const pending = new Set(checkers);
    const deadline = Date.now() + timeoutMinutes * 60_000;

    while (Date.now() < deadline && pending.size > 0) {
      for (const checker of [...pending]) {
        const result = await checker.check();
        if (result) {
          results.set(checker.label, result);
          pending.delete(checker);
        }
      }
      if (pending.size > 0) await delay(POLL_INTERVAL_MS);
    }

    if (pending.size > 0) {
      const done = [...results.entries()]
        .map(([label, r]) => `${label}: ${r.summary}`)
        .join('\n');
      const waiting = [...pending].map((c) => c.label).join(', ');
      return {
        output: `Timed out. Completed:\n${done}\nStill waiting: ${waiting}`,
        summary: `${results.size}/${checkers.length} completed before timeout`,
        isError: true,
      };
    }

    const lines = [...results.entries()].map(
      ([label, r]) => `[${label}] ${r.output}`,
    );
    const hasError = [...results.values()].some((r) => r.isError);
    return {
      output: `All ${checkers.length} targets completed:\n\n${lines.join('\n\n')}`,
      summary: hasError
        ? `All done, some failed`
        : `All ${checkers.length} targets completed`,
      isError: hasError,
    };
  }

  // ---------------------------------------------------------------------------
  // Individual check functions
  // ---------------------------------------------------------------------------

  private async checkComment(
    repo: string,
    issueNumber: number,
    since: string,
    from?: string | null,
  ): Promise<ToolResult | null> {
    const fresh = await this.fetchCommentsSince(repo, issueNumber, since, from);
    if (fresh.length === 0) return null;

    const lines = fresh.map(
      (c) =>
        `--- ${c.user.login} (${c.created_at}) ---\n${c.body}\n${c.html_url}`,
    );
    const authors = [...new Set(fresh.map((c) => c.user.login))].join(', ');
    return {
      output: `${fresh.length} new comment(s) on ${repo}#${issueNumber}:\n\n${lines.join('\n\n')}`,
      summary: `New comment(s) from ${authors} on #${issueNumber}`,
    };
  }

  private async checkActions(
    repo: string,
    headSha: string,
    workflow: string | null | undefined,
    waitFor: 'ci' | 'ci_pass',
  ): Promise<ToolResult | null> {
    const runs = await this.fetchRuns(repo, headSha, workflow);
    if (runs.length === 0) return null;

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
    if (waitFor === 'ci_pass' && failed.length > 0) {
      return {
        output: `Failed early: ${failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(', ')}`,
        summary: `${failed.length} Actions failed`,
        isError: true,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // GitHub API helpers
  // ---------------------------------------------------------------------------

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
    comments = comments.filter(
      (c) => new Date(c.created_at).getTime() >= new Date(since).getTime(),
    );
    if (from) {
      comments = comments.filter((c) => c.user.login === from);
    }
    return comments;
  }
}
