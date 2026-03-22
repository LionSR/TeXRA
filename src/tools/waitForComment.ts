// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getCurrentRepo, gh, sleep } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const InputSchema = z.strictObject({
  repo: z.string().describe('owner/repo. Omit to use current repo.').nullish(),
  pr_number: z.number().int().positive().describe('PR or issue number to monitor.'),
  from: z
    .string()
    .describe('Filter by author login (e.g. "claude[bot]", "codex[bot]", "github-copilot[bot]").')
    .nullish(),
  timeout_minutes: z.number().positive().max(60).prefault(30),
});

export type WaitForCommentInput = z.infer<typeof InputSchema>;

interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

export class WaitForCommentTool extends defineTool({
  name: 'wait_for_comment',
  description:
    'Wait for a new comment on a GitHub PR or issue. ' +
    'Use `from` to filter by author (e.g. "claude[bot]" or "codex[bot]"). ' +
    'Polls every 30s. Requires `gh` CLI.',
  schema: InputSchema,
}) {
  protected async execute(input: WaitForCommentInput): Promise<ToolResult> {
    await ensureGhCli();

    const repo = input.repo ?? (await getCurrentRepo());
    const deadline = Date.now() + (input.timeout_minutes ?? 30) * 60_000;

    // Snapshot current comment IDs to detect new ones
    const baseline = new Set((await this.fetchComments(repo, input.pr_number, input.from)).map((c) => c.id));

    while (Date.now() < deadline) {
      await sleep(30_000);

      const comments = await this.fetchComments(repo, input.pr_number, input.from);
      const fresh = comments.filter((c) => !baseline.has(c.id));

      if (fresh.length > 0) {
        const lines = fresh.map(
          (c) => `--- ${c.user.login} (${c.created_at}) ---\n${c.body}\n${c.html_url}`,
        );
        const authors = [...new Set(fresh.map((c) => c.user.login))].join(', ');
        return {
          output: `${fresh.length} new comment(s) on ${repo}#${input.pr_number}:\n\n${lines.join('\n\n')}`,
          summary: `New comment(s) from ${authors} on #${input.pr_number}`,
        };
      }
    }

    const fromLabel = input.from ? ` from ${input.from}` : '';
    return {
      output: `Timed out waiting for comment${fromLabel} on ${repo}#${input.pr_number}.`,
      summary: `Timed out waiting for comment on #${input.pr_number}`,
      isError: true,
    };
  }

  private async fetchComments(repo: string, prNumber: number, from?: string | null): Promise<Comment[]> {
    const out = await gh(`api repos/${repo}/issues/${prNumber}/comments`);
    let comments: Comment[] = JSON.parse(out || '[]');
    if (from) {
      comments = comments.filter((c) => c.user.login === from);
    }
    return comments;
  }
}
