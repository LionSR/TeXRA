/**
 * Subscribe the current agent stream to GitHub PR activity.
 *
 * Polls GitHub REST every 30s and emits new comments, reviews, line comments,
 * and failed CI checks as follow-ups into this stream's queue. Wraps each
 * event in a `<github-webhook-activity>` tag so the agent recognizes the
 * source. Auto-unsubscribes on PR close/merge.
 */

import { z } from 'zod';

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { ToolError, type ToolResult } from '@tools/result';

import { defineTool } from '../core/define';
import { bindPRSubscription } from './PRSubscriptionBinder';
import { getGitHubToken } from './githubAuth';

const SubscribePRInputSchema = z.strictObject({
  owner: z.string().min(1).describe('Repository owner (user or org)'),
  repo: z.string().min(1).describe('Repository name'),
  pullNumber: z.number().int().positive().describe('Pull request number'),
});

type SubscribePRInput = z.infer<typeof SubscribePRInputSchema>;

export class SubscribePRTool extends defineTool({
  name: 'subscribe_pr_activity',
  description: [
    'Subscribe this stream to GitHub pull request activity.',
    'Every new comment, review, line comment, and failed CI check will arrive as a follow-up message wrapped in <github-webhook-activity> tags, exactly as if the user had typed it.',
    'When such a follow-up arrives, treat it like user input: investigate what it refers to, fix it if the action is small and unambiguous, ask the user if the change is architecturally significant or the request is ambiguous, or skip the event if no action is needed.',
    'Do NOT re-post the event text as a comment on GitHub — that would create a self-loop; your job is to react to events, not echo them.',
    'The subscription is scoped to the current stream: sub-agents spawned via delegate_agent do not inherit it. Delegation results come through their own follow-up channel.',
    'Subscriptions auto-terminate when the PR is closed or merged. Poll interval ≈ 30s. Up to 10 concurrent PRs. Requires a GitHub token — set it in TeXRA settings → Git tab, or via the GITHUB_TOKEN environment variable.',
  ].join(' '),
  schema: SubscribePRInputSchema,
}) {
  protected async execute(input: SubscribePRInput): Promise<ToolResult> {
    if (!getGitHubToken()) {
      throw new ToolError(
        'No GitHub token configured. Open TeXRA settings → Git tab → "Set token" (or export GITHUB_TOKEN). Needs `repo` scope for private PRs, `public_repo` for public.',
      );
    }
    const streamId = getCurrentToolFileInteractionContext()?.streamId;
    if (!streamId) {
      throw new ToolError(
        'subscribe_pr_activity must be called from within an agent stream.',
      );
    }
    const created = bindPRSubscription(streamId, input);
    const slug = `${input.owner}/${input.repo}#${input.pullNumber}`;
    return {
      summary: created
        ? `Subscribed to ${slug}`
        : `Already subscribed to ${slug}`,
      output: created
        ? `Subscribed to ${slug}. New comments, reviews, line comments, and failed CI checks will arrive as follow-up messages wrapped in <github-webhook-activity>. Poll interval ≈ 30s. Auto-unsubscribes on close/merge.`
        : `Already subscribed to ${slug}. You will continue to receive PR activity as follow-up messages until the PR closes or you call unsubscribe_pr_activity.`,
    };
  }
}
