// Third-party imports
import { z } from 'zod';

// Local imports
import { ensureGhCli, getCurrentRepo, getCurrentBranch, gh, sleep } from '@tools/ghUtils';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const InputSchema = z.strictObject({
  repo: z.string().describe('owner/repo. Omit to use current repo.').nullish(),
  ref: z.string().describe('Branch or tag to monitor. Omit for current branch.').nullish(),
  pr_number: z.number().int().positive().describe('PR number to monitor instead of ref.').nullish(),
  workflow: z.string().describe('Filter to a specific workflow file (e.g. "ci.yml").').nullish(),
  wait_for: z
    .enum(['completion', 'success'])
    .prefault('completion')
    .describe('"completion" waits for all to finish; "success" fails fast on any failure.'),
  timeout_minutes: z.number().positive().max(60).prefault(30),
});

export type WaitForActionsInput = z.infer<typeof InputSchema>;

interface RunInfo {
  status: string;
  conclusion: string | null;
  url: string;
  workflowName: string;
}

export class WaitForActionsTool extends defineTool({
  name: 'wait_for_actions',
  description:
    'Wait for GitHub Actions workflow runs to complete on a branch or PR. ' +
    'Polls every 30s until all runs finish. Requires `gh` CLI.',
  schema: InputSchema,
}) {
  protected async execute(input: WaitForActionsInput): Promise<ToolResult> {
    await ensureGhCli();

    const repo = input.repo ?? (await getCurrentRepo());
    const deadline = Date.now() + (input.timeout_minutes ?? 30) * 60_000;

    // Resolve branch
    let branch: string;
    if (input.pr_number) {
      branch = (await gh(`pr view ${input.pr_number} -R ${repo} --json headRefName -q .headRefName`)).trim();
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
      const failed = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped');

      if (running.length === 0) {
        return this.formatResult(runs, failed, repo);
      }

      if (input.wait_for === 'success' && failed.length > 0) {
        return {
          output: `Failed early: ${failed.map((r) => `${r.workflowName} (${r.conclusion})`).join(', ')}`,
          summary: `${failed.length} Actions failed`,
          isError: true,
        };
      }

      lastStatus = `${running.length} running, ${runs.length - running.length} done`;
      await sleep(30_000);
    }

    return { output: `Timed out (${lastStatus})`, summary: 'Timed out', isError: true };
  }

  private async fetchRuns(repo: string, branch: string, workflow?: string | null): Promise<RunInfo[]> {
    const parts = [`run list -R ${repo} --branch ${branch} --limit 20`];
    if (workflow) parts.push(`--workflow ${workflow}`);
    parts.push('--json status,conclusion,url,workflowName');
    const out = await gh(parts.join(' '));
    return JSON.parse(out || '[]') as RunInfo[];
  }

  private formatResult(runs: RunInfo[], failed: RunInfo[], repo: string): ToolResult {
    const lines = runs.map((r) => `- ${r.workflowName}: ${r.conclusion ?? r.status} (${r.url})`);
    const allPassed = failed.length === 0;
    return {
      output: `${runs.length} run(s) completed for ${repo}:\n${lines.join('\n')}`,
      summary: allPassed ? `All ${runs.length} Actions passed` : `${failed.length}/${runs.length} failed`,
      isError: !allPassed,
    };
  }
}
