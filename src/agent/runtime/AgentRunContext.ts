// Local imports - agent components
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

export interface AgentRunContextMetadata {
  agentName: string;
  model: string;
  inputFile?: string | null;
}

export interface AgentRunContext {
  readonly streamTabId: StreamTabId;
  readonly executionId?: ExecutionId;
  readonly logger: AgentLogger;
  readonly session: AgentSessionDescriptor;
  readonly metadata: AgentRunContextMetadata;
}

export interface CreateAgentRunContextParams {
  streamTabId: StreamTabId;
  executionId?: ExecutionId;
  session: AgentSessionDescriptor;
  agentName: string;
  model: string;
  inputFile?: string | null;
}

export function createAgentRunContext(
  params: CreateAgentRunContextParams,
): AgentRunContext {
  const { streamTabId, executionId, session, agentName, model, inputFile } =
    params;

  return {
    streamTabId,
    executionId,
    logger: new AgentLogger(streamTabId, true),
    session,
    metadata: {
      agentName,
      model,
      inputFile: inputFile ?? undefined,
    },
  };
}
