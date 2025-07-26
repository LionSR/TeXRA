// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting } from '../core/AgentDataclass';
import { IAgent } from '../core/IAgent';
import type { IModelHandler } from '../modelHandlers';
import { buildUserVars } from '../utils/userVars';

// Local imports - utilities
import { SHORT_SLEEP_MS } from '@utils/config';
import { sleep } from '@utils/helpers';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

/**
 * Minimal abstract base class providing shared setup and interruption logic.
 */
export abstract class BaseAgent implements IAgent {
  protected modelHandler: IModelHandler;
  protected agentConfig: AgentConfig;
  protected agentSetting: AgentSetting;
  protected agentPrompt: AgentPrompt;
  protected agentPath: string;
  protected logger: AgentLogger;
  protected runGroupId?: string;
  protected userVars: Record<string, any> = {};
  protected client: any;
  protected isInterrupted = false;
  protected abortController: AbortController | null = null;
  protected executionId?: ExecutionId;

  private static runningAgents: Map<string, BaseAgent> = new Map();

  public get config(): AgentConfig {
    return this.agentConfig;
  }

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    this.modelHandler = modelHandler;
    this.agentConfig = agentConfig;
    this.agentSetting = agentSetting;
    this.agentPrompt = agentPrompt;
    this.agentPath = agentPath;

    const streamTabId = this.getStreamTabId();
    this.logger = new AgentLogger(streamTabId, true);
    this.modelHandler.setLogger(this.logger);
  }

  /** Initialize the API client. */
  protected async initializeClient(): Promise<void> {
    this.client = await this.modelHandler.getClient();
    await sleep(SHORT_SLEEP_MS);
  }

  /** Compute the stream tab identifier for this agent execution. */
  protected getStreamTabId(): StreamTabId {
    const baseName = path.basename(this.agentConfig.inputFile);
    const agentName =
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 1
        ? `${this.agentConfig.agent}_multiple`
        : this.agentConfig.agent;
    return `${agentName}@${this.agentConfig.model}: ${baseName}`;
  }

  /** Gather variables used for prompt rendering. */
  protected async getUserVars(): Promise<Record<string, any>> {
    return buildUserVars(
      this.agentConfig,
      this.agentSetting,
      this.agentPath,
      this.modelHandler,
      this.logger,
    );
  }

  /** Perform asynchronous initialization work. */
  public async init(parentGroupId?: string): Promise<void> {
    const initGroupId = await this.logger.startGroup(
      `Init`,
      undefined,
      parentGroupId,
    );
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
      this.logger.endGroup(initGroupId, 'stopped');
    } catch (error) {
      this.logger.endGroup(initGroupId, 'error');
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
