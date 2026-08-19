/**
 * Shared "reserve and take ownership of one agent-identity child execution"
 * ceremony, used by every delegation path that launches a plain agent (as
 * opposed to a multi-agent workflow run, which registers a different
 * identity kind and config shape).
 *
 * Split into a pure parse step and an async registration step so a caller
 * that wraps registration failures (e.g. into a durability error) can keep
 * config-validation failures outside that wrapping, matching how a config
 * parse error and a lease-registration error are meant to propagate
 * differently to their caller.
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

interface ParsedAgentChildConfig {
  readonly config: AgentConfig;
  readonly childStreamId: StreamTabId;
}

/**
 * Parse the child's config and derive its stream id. Must derive the stream
 * id from the same fields `AgentLaunchContext`'s `reservedStreamId` uses (the
 * parsed config's `agent`, not a caller-supplied display name), or the loop
 * acquires the wrong follow-up queue/interrupt slot.
 */
export function parseAgentChildConfig(
  configPayload: AgentConfigPayload,
  executionId: ExecutionId,
): ParsedAgentChildConfig {
  const config = AgentConfigSchema.parse(configPayload);
  const childStreamId = getStreamTabId(config.agent, { executionId });
  return { config, childStreamId };
}

interface RegisterParsedAgentChildExecutionOptions extends ParsedAgentChildConfig {
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly parentExecutionId: ExecutionId | undefined;
  readonly userFollowUpSupport: UserFollowUpSupport;
}

/** Register the owned execution lease for an already-parsed child config. */
export async function registerParsedAgentChildExecution(
  options: RegisterParsedAgentChildExecutionOptions,
): Promise<OwnedExecutionLeaseScope> {
  return registerOwnedExecution(
    options.executionId,
    options.config,
    options.agentName,
    {
      streamId: options.childStreamId,
      identity: { kind: 'agent', agent: options.config.agent },
      userFollowUpSupport: options.userFollowUpSupport,
      parentExecutionId: options.parentExecutionId,
    },
  );
}

interface RegisterAgentChildExecutionOptions {
  readonly executionId: ExecutionId;
  readonly configPayload: AgentConfigPayload;
  readonly agentName: string;
  readonly parentExecutionId: ExecutionId | undefined;
  /** A fixed support level, or one derived from the parsed config (e.g. by agent category). */
  readonly userFollowUpSupport:
    UserFollowUpSupport | ((config: AgentConfig) => UserFollowUpSupport);
}

interface RegisterAgentChildExecutionResult extends ParsedAgentChildConfig {
  readonly runWithOwnership: OwnedExecutionLeaseScope;
}

/** Parse and register in one call, for callers with no separate error handling to preserve across the two steps. */
export async function registerAgentChildExecution(
  options: RegisterAgentChildExecutionOptions,
): Promise<RegisterAgentChildExecutionResult> {
  const { config, childStreamId } = parseAgentChildConfig(
    options.configPayload,
    options.executionId,
  );
  const userFollowUpSupport =
    typeof options.userFollowUpSupport === 'function'
      ? options.userFollowUpSupport(config)
      : options.userFollowUpSupport;
  const runWithOwnership = await registerParsedAgentChildExecution({
    executionId: options.executionId,
    config,
    childStreamId,
    agentName: options.agentName,
    parentExecutionId: options.parentExecutionId,
    userFollowUpSupport,
  });
  return { config, childStreamId, runWithOwnership };
}
