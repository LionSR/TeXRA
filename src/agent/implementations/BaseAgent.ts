// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import {
  AgentPrompt,
  AgentSetting,
  type AgentSessionDescriptor,
} from '../core/AgentDataclass';
import { AgentRunState } from '../core/AgentState';
import { IAgent, type AgentRunHooks } from '../core/IAgent';
import type { IModelHandler } from '../modelHandlers';
import { UsageMonitor } from '../utils/UsageMonitor';
import { buildUserVars } from '../utils/userVars';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type {
  AgentCycleBaseOptions,
  UserVariableChannels,
} from '@agent/core/AgentCycleOptions';
import type { AgentRoundFinalizedCallback } from '../core/AgentSharedStore';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

// Local imports - logging
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

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
  protected readonly context: AgentExecutionContext;
  protected logger: AgentLogger;
  protected usageMonitor: UsageMonitor;
  protected runStage?: AgentLogStage;
  private lastRunStageId?: string;
  protected userVars: Record<string, any> = {};
  protected userVarChannels: UserVariableChannels = {
    input: Object.freeze({}),
    transient: {},
    output: {},
  };
  protected client: C | null = null;
  protected isInterrupted = false;
  protected abortController: AbortController | null = null;
  protected executionId?: ExecutionId;

  private static runningAgents: Map<string, BaseAgent> = new Map();

  public get config(): AgentConfig {
    return this.agentConfig;
  }

  public getExecutionContext(): AgentExecutionContext {
    return this.context;
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
    context: AgentExecutionContext,
  ) {
    this.modelHandler = modelHandler;
    this.agentConfig = agentConfig;
    this.agentSetting = agentSetting;
    this.agentPrompt = agentPrompt;
    this.agentPath = agentPath;
    this.context = context;
    this.executionId = context.executionId;

    this.logger = context.logger;
    this.modelHandler.setLogger(this.logger);
    this.modelHandler.setAgentType(this.agentSetting.agentType);
    this.usageMonitor = new UsageMonitor(this.modelHandler, context);
  }

  /** Initialize the API client. */
  protected async initializeClient(): Promise<void> {
    this.client = await this.modelHandler.getClient();
    await sleep(SHORT_SLEEP_MS);
  }

  protected resetTransientUserVars(overrides?: Record<string, any>): void {
    const nextTransient = {
      ...this.userVarChannels.input,
      ...(overrides ?? {}),
    };
    this.userVarChannels.transient = nextTransient;
    this.userVars = this.userVarChannels.transient;
  }

  /** Retrieve the initialized client instance. */
  protected getClientInstance(): C {
    if (this.client === null) {
      throw new Error('Model client has not been initialized.');
    }
    return this.client;
  }

  public getUserVarChannels(): UserVariableChannels {
    return this.userVarChannels;
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
      userVars: this.userVarChannels.transient,
      userVarChannels: this.userVarChannels,
      logger: this.logger,
      context: this.context,
      client,
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
    };
  }

  /** Compute the stream tab identifier for this agent execution. */
  public getStreamTabId(): StreamTabId {
    return this.context.streamId;
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
    parentStage?: AgentLogStage,
    options?: { createStage?: boolean },
  ): Promise<void> {
    const { createStage = true } = options ?? {};
    const runInit = async () => {
      this.logger.debug(`AgentConfig: ${JSON.stringify(this.agentConfig)}`);
      this.logger.debug(`AgentSetting: ${JSON.stringify(this.agentSetting)}`);
      this.logger.debug(
        `ModelConfig: ${JSON.stringify(this.modelHandler.config)}`,
      );

      const baseVars = await this.getUserVars();
      this.userVarChannels = {
        input: Object.freeze({ ...baseVars }),
        transient: {},
        output: {},
      };
      this.resetTransientUserVars();
      this.registerRunningAgent(this.getStreamTabId());
    };

    const parent = parentStage ?? this.runStage;

    if (createStage) {
      const stage = await this.logger.stage('Init', {
        parent,
      });
      await stage.run(runInit);
      return;
    }

    if (parent) {
      await parent.within(runInit);
      return;
    }

    await runInit();
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
    stateGlobal: AgentRunState,
    options?: { runKind?: 'workflow' | 'tool-use' },
  ): Promise<void> {
    await this.usageMonitor.recordUsage(stateGlobal, options);
  }

  public getUsageRecorder(
    runKind: 'workflow' | 'tool-use' = 'workflow',
  ): AgentRoundFinalizedCallback {
    return async ({ run }) => {
      await this.trackRoundUsage(run, { runKind });
    };
  }

  /**
   * Run a callback within a nested log group tied to the current run.
   * @param groupLabel Label to use for the new log group
   * @param callback Callback to execute with the created group ID
   */
  protected async withRoundStage<T>(
    groupLabel: string,
    callback: (stage: AgentLogStage) => Promise<T>,
  ): Promise<T> {
    const stage = await this.logger.stage(groupLabel, {
      parent: this.runStage,
    });
    return stage.run(async () => callback(stage));
  }

  /**
   * Start a log group for this agent's run and store its ID.
   * @param parentGroupId Optional parent group
   * @returns The created group ID
   */
  protected async startRunStage(
    parentStage?: AgentLogStage,
  ): Promise<AgentLogStage> {
    if (this.runStage) {
      this.runStage.end();
      this.lastRunStageId = this.runStage.id;
      this.runStage = undefined;
    }

    const stage = await this.logger.stage(
      `Run: ${this.agentConfig.agent}@${this.agentConfig.model}`,
      {
        parent: parentStage,
      },
    );
    this.runStage = stage;
    this.lastRunStageId = stage.id;
    return stage;
  }

  /**
   * End the current run group.
   * @param status Status to mark for the group
   */
  protected endRunStage(status: 'stopped' | 'error' = 'stopped'): void {
    if (!this.runStage) {
      return;
    }

    this.runStage.end(status);
    this.lastRunStageId = this.runStage.id;
    this.runStage = undefined;
  }

  /**
   * Retrieve the most recently used run group identifier.
   */
  public getLastRunGroupId(): string | undefined {
    return this.lastRunStageId;
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
      start: () => this.startRunStage(),
      init: (runStage) => this.init(runStage),
      initializeClient: () => this.initializeClient(),
      end: (status) => this.endRunStage(status),
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
