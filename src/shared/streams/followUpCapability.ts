import {
  AgentCategory,
  type RunIdentity,
  type StreamPhase,
} from '@shared/schemas';

import { isInFlightPhase } from './streamStatus';

/** Whether the canonical stream facts identify a native agent that can accept follow-ups. */
export function streamAcceptsFollowUps(stream: {
  readonly identity?: RunIdentity | undefined;
  readonly category?: AgentCategory | undefined;
  readonly status?: StreamPhase | undefined;
}): boolean {
  return (
    stream.identity?.kind === 'agent' &&
    stream.identity.tool === undefined &&
    stream.category === AgentCategory.ToolUse &&
    stream.status !== undefined &&
    isInFlightPhase(stream.status)
  );
}
