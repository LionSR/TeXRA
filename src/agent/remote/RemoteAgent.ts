// Local imports - agent configuration
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentCategory,
  AgentType,
  resolveAgentSessionDescriptor,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import type { IAgent } from '@agent/core/IAgent';
import { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import {
  ensureSupabaseClient,
  getCurrentSession,
  getProxySession,
  type RemoteAgentDescriptor,
} from '@common/auth/supabaseClient';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getStreamTabId as buildStreamTabId } from '@/logger/streamUtils';
import { getConfig } from '@utils/config';

interface RemoteAgentResponse {
  logs?: Array<{ level?: string; message: string }>;
  output?: string;
  status?: string;
  usage?: Record<string, unknown>;
  error?: string;
}

export class RemoteAgent implements IAgent {
  public readonly config: AgentConfig;
  private readonly descriptor: RemoteAgentDescriptor;
  private readonly executionId?: ExecutionId;
  private readonly logger: AgentLogger;
  private readonly sessionDescriptor: AgentSessionDescriptor;
  private lastRunGroupId?: string;
  private interrupted = false;

  constructor(
    descriptor: RemoteAgentDescriptor,
    config: AgentConfig,
    executionId?: ExecutionId,
  ) {
    this.descriptor = descriptor;
    this.config = config;
    this.executionId = executionId;
    const agentType = descriptor.isToolUse
      ? AgentType.ToolUse
      : AgentType.Direct;
    const agentCategory = descriptor.isToolUse
      ? AgentCategory.ToolUse
      : AgentCategory.Workflow;
    this.sessionDescriptor = resolveAgentSessionDescriptor(
      agentType,
      agentCategory,
    );
    this.logger = new AgentLogger(this.getStreamTabId(), true);
  }

  async init(parentGroupId?: string): Promise<void> {
    const initGroupId = await this.logger.startGroup(
      'Remote agent preparation',
      undefined,
      parentGroupId,
    );
    this.logger.info(
      `Preparing remote agent "${this.descriptor.displayName}"`,
      initGroupId,
    );
    this.logger.endGroup(initGroupId, 'stopped');
  }

  async run(): Promise<void> {
    if (this.interrupted) {
      this.logger.warn('Remote agent execution cancelled before dispatch.');
      return;
    }

    const client = await ensureSupabaseClient();
    const session = getCurrentSession();
    if (!client || !session) {
      throw new Error(
        'Supabase authentication is required to run remote agents. Please sign in.',
      );
    }

    const proxySession = getProxySession();
    const functionName = getConfig<string>(
      'auth.remoteAgentFunction',
      'execute-remote-agent',
    );

    const runGroupId = await this.logger.startGroup(
      `Remote execution: ${this.descriptor.displayName}`,
    );
    this.lastRunGroupId = runGroupId;

    this.logger.info(
      `Dispatching remote agent ${this.descriptor.name} to Supabase function ${functionName}`,
      runGroupId,
      MESSAGE_TYPES.PROGRESS_STATUS,
    );

    const payload = {
      agent: this.descriptor.name,
      config: this.config,
      proxyToken: proxySession?.token,
      proxySessionId: proxySession?.sessionId,
      timestamp: new Date().toISOString(),
    };

    try {
      const { data, error } =
        await client.functions.invoke<RemoteAgentResponse>(functionName, {
          body: payload,
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
          },
        });

      if (error) {
        throw new Error(error.message);
      }

      this.processResponse(data ?? {}, runGroupId);
      this.logger.endGroup(runGroupId, 'stopped');
    } catch (err) {
      this.logger.error(
        `Remote agent failed: ${err instanceof Error ? err.message : String(err)}`,
        runGroupId,
      );
      this.logger.endGroup(runGroupId, 'error');
      throw err;
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.logger.warn('Stop requested. Awaiting remote response completion.');
  }

  getStreamTabId(): StreamTabId {
    return buildStreamTabId(
      this.config.agent,
      this.config.model,
      this.config.inputFile,
      {
        agentType: this.sessionDescriptor.agentType,
        executionId: this.executionId,
        useMultipleOutputs: this.config.useMultipleOutputs,
      },
    );
  }

  getSessionMetadata(): AgentSessionDescriptor {
    return this.sessionDescriptor;
  }

  getLastRunGroupId(): string | undefined {
    return this.lastRunGroupId;
  }

  private processResponse(
    response: RemoteAgentResponse,
    groupId: string,
  ): void {
    if (Array.isArray(response.logs)) {
      for (const entry of response.logs) {
        const level = (entry.level ?? 'info').toLowerCase();
        const message = entry.message ?? '';
        if (!message) {
          continue;
        }
        switch (level) {
          case 'error':
            this.logger.error(message, groupId);
            break;
          case 'warn':
          case 'warning':
            this.logger.warn(message, groupId);
            break;
          case 'debug':
            this.logger.debug(message, groupId);
            break;
          default:
            this.logger.info(message, groupId);
        }
      }
    }

    if (response.status) {
      this.logger.info(`Status: ${response.status}`, groupId);
    }

    if (response.output) {
      this.logger.info(response.output, groupId, MESSAGE_TYPES.MODEL_RESPONSE);
    }

    if (response.usage) {
      this.logger.info(
        `Usage summary: ${JSON.stringify(response.usage)}`,
        groupId,
        MESSAGE_TYPES.STATISTICS,
      );
    }

    if (response.error) {
      this.logger.error(response.error, groupId);
    }
  }
}
