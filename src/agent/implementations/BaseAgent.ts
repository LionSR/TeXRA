// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import {
  AgentPrompt,
  AgentSetting,
  type AgentSessionDescriptor,
} from '../core/AgentDataclass';
import { AgentStateGlobal } from '../core/AgentState';
import { IAgent, type AgentRunHooks } from '../core/IAgent';
import type { IModelHandler } from '../modelHandlers';
import { UsageMonitor } from '../utils/UsageMonitor';
import { buildUserVars } from '../utils/userVars';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';

// Local imports - logging
import { AgentLogger, AgentLogScope } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
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
  protected logger: AgentLogger;
  protected usageMonitor: UsageMonitor;
  protected runGroupId?: string;
  private lastRunGroupId?: string;
  protected userVars: Record<string, any> = {};
  protected client: C | null = null;
  protected isInterrupted = false;
  protected abortController: AbortController | null = null;
  protected executionId?: ExecutionId;

  private static runningAgents: Map<string, BaseAgent> = new Map();

  public get config(): AgentConfig {
    return this.agentConfig;
  }

  public getSessionMetadata(): AgentSessionDescriptor {
    if (!this.agentConfig.session) {
      throw new Error('Agent configuration is missing session metadata.');
    }

    return this.agentConfig.session;
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
    this.logger = new AgentLogger(streamTabId, true);
    this.modelHandler.setLogger(this.logger);
    this.modelHandler.setAgentType(this.agentSetting.agentType);
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

  protected buildCycleBaseOptions<S extends AgentSetting>(params: {
    agentSetting: S;
    agentPrompt: AgentPrompt;
    client: C;
  }): AgentCycleBaseOptions<C> {
    const { agentSetting, agentPrompt, client } = params;
    return {
      modelHandler: this.modelHandler,
      agentSetting,
      agentPrompt,
      userVars: this.userVars,
      logger: this.logger,
      client,
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
      executionId: this.executionId,
    };
  }

  /** Compute the stream tab identifier for this agent execution. */
  public getStreamTabId(): StreamTabId {
    const metadata = this.getSessionMetadata();
    return buildStreamTabId(
      this.agentConfig.agent,
      this.agentConfig.model,
      this.agentConfig.inputFile,
      {
        agentType: metadata.agentType,
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
      this.registerRunningAgent(this.getStreamTabId());

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
      this.logger.info(
        'Stopping due to user interruption',
        undefined,
        MESSAGE_TYPES.PROGRESS_STATUS,
      );
      return true;
    }
    return false;
  }

  public isInterruptionRequested(): boolean {
    return this.isInterrupted;
  }

  public setExecutionId(id: ExecutionId): void {
    this.executionId = id;
  }

  public getExecutionId(): ExecutionId | undefined {
    return this.executionId;
  }

  protected async trackRoundUsage(
    stateGlobal: AgentStateGlobal,
    scope?: AgentLogScope,
  ): Promise<void> {
    await this.usageMonitor.recordUsage(stateGlobal, scope);
  }

  /**
   * Run a callback within a nested log group tied to the current run.
   * @param groupLabel Label to use for the new log group
   * @param callback Callback to execute with the created group ID
   */
  protected async withRoundGroup<T>(
    groupLabel: string,
    callback: (scope: AgentLogScope) => Promise<T>,
  ): Promise<T> {
    return this.logger.withGroup(
      groupLabel,
      async (scope) => await callback(scope),
      { parentGroupId: this.runGroupId },
    );
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
    this.lastRunGroupId = this.runGroupId;
    return this.runGroupId;
  }

  /**
   * End the current run group.
   * @param status Status to mark for the group
   */
  protected endRunGroup(status: 'stopped' | 'error' = 'stopped'): void {
    if (this.runGroupId) {
      this.lastRunGroupId = this.runGroupId;
      this.logger.endGroup(this.runGroupId, status);
      this.runGroupId = undefined;
    }
  }

  /**
   * Retrieve the most recently used run group identifier.
   */
  public getLastRunGroupId(): string | undefined {
    return this.lastRunGroupId;
  }

  public static getRunningAgent(
    streamTabId: StreamTabId,
  ): BaseAgent | undefined {
    return BaseAgent.runningAgents.get(streamTabId);
  }

  protected cleanup(): void {
    const streamTabId = this.getStreamTabId();
    this.unregisterRunningAgent(streamTabId);
  }

  public getRunHooks(overrides?: Partial<AgentRunHooks>): AgentRunHooks {
    const baseHooks: AgentRunHooks = {
      start: () => this.startRunGroup(),
      init: (runGroupId) => this.init(runGroupId),
      initializeClient: () => this.initializeClient(),
      end: (status) => this.endRunGroup(status),
      cleanup: () => this.cleanup(),
    };

    return {
      start: overrides?.start ?? baseHooks.start,
      init: overrides?.init ?? baseHooks.init,
      initializeClient:
        overrides?.initializeClient ?? baseHooks.initializeClient,
      end: overrides?.end ?? baseHooks.end,
      cleanup: overrides?.cleanup ?? baseHooks.cleanup,
    };
  }

  protected registerRunningAgent(streamTabId: StreamTabId): void {
    BaseAgent.runningAgents.set(streamTabId, this);
  }

  protected unregisterRunningAgent(streamTabId: StreamTabId): void {
    BaseAgent.runningAgents.delete(streamTabId);
  }

  abstract run(): Promise<void>;
}
