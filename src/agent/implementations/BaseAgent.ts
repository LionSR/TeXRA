// Local imports - agent

// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting } from '../core/AgentDataclass';
import { AgentStateGlobal } from '../core/AgentState';
import { IAgent } from '../core/IAgent';
import type { IModelHandler } from '../modelHandlers';
import { UsageMonitor } from '../utils/UsageMonitor';
import { buildUserVars } from '../utils/userVars';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - log
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';
import { getStreamTabId as buildStreamTabId } from '@/logger/streamUtils';

// Local imports - utilities
import { SHORT_SLEEP_MS } from '@utils/config';
import { sleep } from '@utils/helpers';

/**
 * Minimal abstract base class providing shared setup and interruption logic.
 */
export abstract class BaseAgent<C = unknown> implements IAgent {
  protected modelHandler: IModelHandler<any, any, any, any, C>;
  protected agentConfig: AgentConfig;
  protected agentSetting: AgentSetting;
  protected agentPrompt: AgentPrompt;
  protected agentPath: string;
  protected logger: ChannelLogger;
  protected usageMonitor: UsageMonitor;
  protected runGroupId?: string;
  protected userVars: Record<string, any> = {};
  protected client: C | null = null;
  protected isInterrupted = false;
  protected abortController: AbortController | null = null;
  protected executionId?: ExecutionId;

  private static runningAgents: Map<string, BaseAgent> = new Map();

  public get config(): AgentConfig {
    return this.agentConfig;
  }

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    executionId?: ExecutionId,
  ) {
    this.modelHandler = modelHandler;
    this.agentConfig = agentConfig;
    this.agentSetting = agentSetting;
    this.agentPrompt = agentPrompt;
    this.agentPath = agentPath;
    this.executionId = executionId;

    const streamTabId = this.getStreamTabId();
    this.logger = createChannelLogger(streamTabId, { isAgent: true });
    this.modelHandler.setLogger(this.logger);
    this.usageMonitor = new UsageMonitor(
      this.modelHandler,
      this.logger.channelId,
      this.logger,
    );
  }

  /** Initialize the API client. */
  protected async initializeClient(): Promise<void> {
    this.client = await this.modelHandler.getClient();
    await sleep(SHORT_SLEEP_MS);
  }

  /** Retrieve the initialized client instance. */
  protected getClientInstance(): C {
    if (this.client === null) {
      throw new Error('Model client has not been initialized.');
    }
    return this.client;
  }

  /** Compute the stream tab identifier for this agent execution. */
  protected getStreamTabId(): StreamTabId {
    return buildStreamTabId(
      this.agentConfig.agent,
      this.agentConfig.model,
      this.agentConfig.inputFile,
      {
        agentType: this.agentSetting.agentType,
        executionId: this.executionId,
        useMultipleOutputs: this.agentConfig.useMultipleOutputs,
      },
    );
  }

  /** Gather variables used for prompt rendering. */
  protected async getUserVars(): Promise<Record<string, any>> {
    return buildUserVars(
      this.agentConfig,
      this.agentSetting,
      this.agentPrompt,
      this.agentPath,
      this.modelHandler,
      this.logger,
    );
  }

  /** Perform asynchronous initialization work. */
  public async init(
    parentGroupId?: string,
    options?: { createGroup?: boolean },
  ): Promise<void> {
    const { createGroup = true } = options ?? {};
    const initGroupId = createGroup
      ? await this.logger.startGroup(`Init`, undefined, parentGroupId)
      : parentGroupId;

    try {
      this.logger.debug(
        `AgentConfig: ${JSON.stringify(this.agentConfig)}`,
        initGroupId,
      );
      this.logger.debug(
        `AgentSetting: ${JSON.stringify(this.agentSetting)}`,
        initGroupId,
      );
      this.logger.debug(
        `ModelConfig: ${JSON.stringify(this.modelHandler.config)}`,
        initGroupId,
      );

      this.userVars = await this.getUserVars();
      BaseAgent.runningAgents.set(this.getStreamTabId(), this);

      if (createGroup && initGroupId) {
        this.logger.endGroup(initGroupId, 'stopped');
      }
    } catch (error) {
      if (createGroup && initGroupId) {
        this.logger.endGroup(initGroupId, 'error');
      }
      throw error;
    }
  }

  /** Interrupt the agent's execution. */
  public interrupt(): void {
    this.isInterrupted = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.logger.error(
      'Agent execution interrupted by user. Active request aborted; partial output may remain.',
    );
  }

  /** Check if the agent should stop due to user interruption. */
  protected checkInterruption(): boolean {
    if (this.isInterrupted) {
      this.logger.info('Stopping due to user interruption');
      return true;
    }
    return false;
  }

  public setExecutionId(id: ExecutionId): void {
    this.executionId = id;
  }

  public getExecutionId(): ExecutionId | undefined {
    return this.executionId;
  }

  protected async trackRoundUsage(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void> {
    await this.usageMonitor.recordUsage(stateGlobal, groupId);
  }

  /**
   * Run a callback within a nested log group tied to the current run.
   * @param groupLabel Label to use for the new log group
   * @param callback Callback to execute with the created group ID
   */
  protected async withRoundGroup<T>(
    groupLabel: string,
    callback: (groupId: string) => Promise<T>,
  ): Promise<T> {
    const groupId = await this.logger.startGroup(
      groupLabel,
      undefined,
      this.runGroupId,
    );

    let status: 'stopped' | 'error' = 'stopped';
    try {
      return await callback(groupId);
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      this.logger.endGroup(groupId, status);
    }
  }

  /**
   * Start a log group for this agent's run and store its ID.
   * @param parentGroupId Optional parent group
   * @returns The created group ID
   */
  protected async startRunGroup(parentGroupId?: string): Promise<string> {
    this.runGroupId = await this.logger.startGroup(
      `Run: ${this.agentConfig.agent}@${this.agentConfig.model}`,
      undefined,
      parentGroupId,
    );
    return this.runGroupId;
  }

  /**
   * End the current run group.
   * @param status Status to mark for the group
   */
  protected endRunGroup(status: 'stopped' | 'error' = 'stopped'): void {
    if (this.runGroupId) {
      this.logger.endGroup(this.runGroupId, status);
      this.runGroupId = undefined;
    }
  }

  public static getRunningAgent(
    streamTabId: StreamTabId,
  ): BaseAgent | undefined {
    return BaseAgent.runningAgents.get(streamTabId);
  }

  protected cleanup(): void {
    const streamTabId = this.getStreamTabId();
    BaseAgent.runningAgents.delete(streamTabId);
  }

  abstract run(): Promise<void>;
}
