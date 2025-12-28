// Local imports - agent components
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentCategory,
  AgentPrompt,
  AgentSetting,
  type AgentSessionDescriptor,
  type AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { AgentRunState } from '@agent/core/AgentState';
import type { IAgent } from '@agent/core/IAgent';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { buildUserVars } from '@agent/utils/userVars';
// Type imports
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type {
  AgentCycleBaseOptions,
  UserVariableChannels,
} from '@agent/core/AgentCycleOptions';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';
import type { IInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
// Internal imports
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  type EndGroupStatus,
} from '@logger/messageTypes';
import { SHORT_SLEEP_MS } from '@utils/config';
import { sleep } from '@utils/core';

/**
 * Minimal abstract base class providing shared setup and interruption logic.
 *
 * Implements IInterruptible for unified interrupt handling via the execution registry.
 */
export abstract class BaseAgent<C = unknown> implements IAgent, IInterruptible {
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
  protected userVarChannels: UserVariableChannels = {
    input: Object.freeze({}),
    transient: {},
    output: {},
  };
  protected client: C | null = null;
  protected isInterrupted = false;
  protected abortController: AbortController | null = null;
  protected readonly executionId: ExecutionId;

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
    // Extract isMultipleOutput from workflow settings (undefined for tool-use)
    const isMultipleOutput =
      agentSetting.agentCategory === AgentCategory.Workflow
        ? (agentSetting as AgentWorkflowSetting).isMultipleOutput
        : undefined;

    this.usageMonitor = new UsageMonitor(this.modelHandler, context, {
      agentName: agentConfig.agent,
      agentCategory: agentSetting.agentCategory,
      isMultipleOutput,
    });
  }

  /** Initialize the API client. Called by flow init nodes. */
  public async initializeClient(): Promise<void> {
    this.client = await this.modelHandler.getClient();
    await sleep(SHORT_SLEEP_MS);
  }

  protected resetTransientUserVars(overrides?: Record<string, any>): void {
    this.userVarChannels.transient = {
      ...this.userVarChannels.input,
      ...(overrides ?? {}),
    };
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
      this.registerInRegistry(this.getStreamTabId());
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
    this.abortController?.abort();
    // Clean up any pending retry request to avoid memory leaks
    retryCoordinator.clearRequest(this.getStreamTabId());
    this.logger.error(
      'Agent execution interrupted by user. Active request aborted; partial output may remain.',
    );
  }

  /** Check if the agent should stop due to user interruption. */
  protected checkInterruption(): boolean {
    if (this.isInterrupted) {
      this.logger.info('Stopping due to user interruption', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      return true;
    }
    return false;
  }

  public isInterruptionRequested(): boolean {
    return this.isInterrupted;
  }

  // =========================================================================
  // IFlowAgent Lifecycle Methods
  // These delegate to internal methods and provide the unified interface
  // that flows depend on. They have identical implementations across all agents.
  // =========================================================================

  public async startAndInitRun(): Promise<void> {
    const runStage = await this.startRunStage();
    await this.init(runStage);
  }

  // initializeClient() already exists and matches the interface

  public endRun(status: EndGroupStatus): void {
    this.endRunStage(status);
  }

  public cleanupRun(): void {
    this.cleanup();
  }

  public getExecutionId(): ExecutionId {
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
  protected endRunStage(
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
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

  protected cleanup(): void {
    const streamTabId = this.getStreamTabId();
    this.unregisterFromRegistry(streamTabId);
  }

  /**
   * Register this agent in the unified execution registry.
   * Called during init() to enable interrupt handling.
   */
  protected registerInRegistry(streamTabId: StreamTabId): void {
    registerInterruptible(streamTabId, this);
  }

  /**
   * Unregister this agent from the unified execution registry.
   * Called during cleanup() when execution completes.
   */
  protected unregisterFromRegistry(streamTabId: StreamTabId): void {
    unregisterInterruptible(streamTabId);
  }

  abstract run(): Promise<void>;
}
