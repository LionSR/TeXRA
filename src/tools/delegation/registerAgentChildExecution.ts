/**
 * Shared "reserve and take ownership of one agent-identity child execution"
 * ceremony, used by every delegation path that launches a plain agent (as
 * opposed to a multi-agent workflow run, which registers a different
 * identity kind and config shape).
 */

// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { OwnedExecutionLeaseScope } from '@agent/storage/executionLease';
import { registerOwnedExecution } from '@agent/storage/executionLifecycle';
import { getStreamTabId } from '@agent/runtime/streamTab';
import type {
  ExecutionId,
  StreamTabId,
  UserFollowUpSupport,
} from '@shared/schemas';

interface RegisterAgentChildExecutionOptions {
  readonly executionId: ExecutionId;
  readonly configPayload: AgentConfigPayload;
  readonly agentName: string;
  readonly parentExecutionId: ExecutionId | undefined;
  /** A fixed support level, or one derived from the parsed config (e.g. by agent category). */
  readonly userFollowUpSupport:
    UserFollowUpSupport | ((config: AgentConfig) => UserFollowUpSupport);
}

interface RegisterAgentChildExecutionResult {
  readonly config: AgentConfig;
  readonly childStreamId: StreamTabId;
  readonly runWithOwnership: OwnedExecutionLeaseScope;
}

/**
 * Must derive the stream id from the same fields `AgentLaunchContext`'s
 * `reservedStreamId` uses (the parsed config's `agent`, not a caller-supplied
 * display name), or the loop acquires the wrong follow-up queue/interrupt
 * slot.
 */
export async function registerAgentChildExecution(
  options: RegisterAgentChildExecutionOptions,
): Promise<RegisterAgentChildExecutionResult> {
  const config = AgentConfigSchema.parse(options.configPayload);
  const childStreamId = getStreamTabId(config.agent, {
    executionId: options.executionId,
  });
  const userFollowUpSupport =
    typeof options.userFollowUpSupport === 'function'
      ? options.userFollowUpSupport(config)
      : options.userFollowUpSupport;
  const runWithOwnership = await registerOwnedExecution(
    options.executionId,
    config,
    options.agentName,
    {
      streamId: childStreamId,
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport,
      parentExecutionId: options.parentExecutionId,
    },
  );
  return { config, childStreamId, runWithOwnership };
}
