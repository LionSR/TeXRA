import {
  AgentCategory,
  STREAM_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  type RunIdentity,
  type StreamLifecycleStatus,
  type StreamPhase,
  type UserFollowUpSupport,
} from '@shared/schemas';

import { isInFlightPhase, isTerminalOutcomePhase } from './streamStatus';

export type UserFollowUpAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: 'unsupported' | 'pending' | 'terminal';
      readonly message: string;
    };

/**
 * Canonical host admission policy for user-authored follow-ups. Runtime support
 * comes from launch metadata; the current lifecycle phase prevents stale views
 * from reviving a run that has already ended.
 */
export function userFollowUpAvailability(stream: {
  readonly userFollowUpSupport?: UserFollowUpSupport | undefined;
  readonly status?: StreamLifecycleStatus | undefined;
}): UserFollowUpAvailability {
  if (
    stream.userFollowUpSupport === undefined ||
    stream.userFollowUpSupport === USER_FOLLOW_UP_SUPPORT.UNSUPPORTED
  ) {
    return {
      available: false,
      reason: 'unsupported',
      message: 'This run does not accept follow-up messages.',
    };
  }
  const status =
    stream.status === STREAM_STATUS.READY ? undefined : stream.status;
  if (isInFlightPhase(status)) return { available: true };
  if (isTerminalOutcomePhase(status)) {
    return {
      available: false,
      reason: 'terminal',
      message: 'This run has ended. Start a new agent task to continue.',
    };
  }
  return {
    available: false,
    reason: 'pending',
    message: 'Wait for this run to start, then try again.',
  };
}

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
