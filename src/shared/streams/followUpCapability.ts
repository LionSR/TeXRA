import {
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type RunIdentity,
  type StreamPhase,
  type UserFollowUpSupport,
} from '@shared/schemas';

import { isInFlightPhase } from './streamStatus';

/**
 * Whether the child composer policy allows user follow-ups for this stream.
 * Terminal-backed agents consume follow-up queues at runtime, but this policy
 * deliberately keeps their composer hidden until the parity work supports it.
 */
export function streamAllowsChildFollowUpComposer(stream: {
  readonly identity?: RunIdentity | undefined;
  readonly userFollowUpSupport?: UserFollowUpSupport | undefined;
  readonly category?: AgentCategory | undefined;
  readonly status?: StreamPhase | undefined;
}): boolean {
  return (
    stream.userFollowUpSupport === USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE &&
    stream.identity?.kind === 'agent' &&
    stream.identity.tool === undefined &&
    stream.category === AgentCategory.ToolUse &&
    stream.status !== undefined &&
    isInFlightPhase(stream.status)
  );
}
