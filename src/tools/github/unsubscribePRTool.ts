/**
 * Unsubscribe the current agent stream from a GitHub PR subscription.
 * Idempotent — returns quietly if the stream wasn't subscribed.
 */

import { z } from 'zod';

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { ToolError, type ToolResult } from '@tools/result';

import { defineTool } from '../core/define';
import { unbindPRSubscription } from './PRSubscriptionBinder';

const UnsubscribePRInputSchema = z.strictObject({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
});

type UnsubscribePRInput = z.infer<typeof UnsubscribePRInputSchema>;

export class UnsubscribePRTool extends defineTool({
  name: 'unsubscribe_pr_activity',
  description:
    'Unsubscribe this stream from a previously-subscribed GitHub pull request. No effect if not subscribed.',
  schema: UnsubscribePRInputSchema,
}) {
  protected async execute(input: UnsubscribePRInput): Promise<ToolResult> {
    const streamId = getCurrentToolFileInteractionContext()?.streamId;
    if (!streamId) {
      throw new ToolError(
        'unsubscribe_pr_activity must be called from within an agent stream.',
      );
    }
    const { wasSubscribed } = unbindPRSubscription(streamId, input);
    const slug = `${input.owner}/${input.repo}#${input.pullNumber}`;
    return {
      summary: wasSubscribed
        ? `Unsubscribed from ${slug}`
        : `Was not subscribed to ${slug}`,
    };
  }
}
