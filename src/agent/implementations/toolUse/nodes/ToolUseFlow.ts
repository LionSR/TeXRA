// Standard library imports

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';
import {
  runToolUseCycle,
  type ToolUseCycleOptions,
} from '@agent/core/ToolUseCycle';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { Flow, Node } from '@agent/node';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

// Local imports - tool registry
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - prompt helpers
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { renderPrompt } from '@agent/utils/promptUtils';
import { TOOL_USE_INSTRUCTIONS } from '@agent/utils/toolUsePrompt';

// Local imports - agent implementation
import type { BaseToolUseAgent } from '../../BaseToolUseAgent';

// Shared state ----------------------------------------------------------------------------------

export interface ToolUseRunShared<C> {
  agent: BaseToolUseAgent<C>;
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  modelHandler: IModelHandler<any, any, any, any, C>;
  toolRegistry: Record<string, BaseTool<any>>;
  logger: AgentLogger;
  shouldSkipCycle: boolean;
  cycleOptions?: ToolUseCycleOptions<C>;
  getUserVars: () => Record<string, any>;
  getMessages: () => ProviderMessage[];
  setMessages: (messages: ProviderMessage[]) => void;
  getToolState: () => ToolState | null;
  setToolState: (state: ToolState | null) => void;
  getResumeSnapshot: () => ToolUseSessionSnapshot | null;
  setResumeSnapshot: (snapshot: ToolUseSessionSnapshot | null) => void;
  waitForFollowUp: () => Promise<string | null>;
  hasQueuedFollowUp: () => boolean;
  enterWaitingState: () => Promise<void>;
  clearPersistedSnapshot: () => Promise<void>;
  markRunning: () => Promise<void>;
  logUserMessage: (text: string) => void;
  createUserFollowUpMessages: (
    messages: ProviderMessage[],
    followUp: string,
  ) => Promise<ProviderMessage[]>;
  checkInterruption: () => boolean;
  initializeClient: () => Promise<void>;
  getClientInstance: () => C;
  initAgent: () => Promise<void>;
  resolveTools: () => ToolDefinition[];
  setAbortController: (ctrl: AbortController | null) => void;
}

interface ToolUseSessionPrep<C> {
  agentPrompt: AgentPrompt;
  agentSetting: AgentSetting;
  agentConfig: AgentConfig;
  modelHandler: IModelHandler<any, any, any, any, C>;
  toolRegistry: Record<string, BaseTool<any>>;
  logger: AgentLogger;
  resumeSnapshot: ToolUseSessionSnapshot | null;
  getUserVars: () => Record<string, any>;
  initAgent: () => Promise<void>;
  initializeClient: () => Promise<void>;
  getClientInstance: () => C;
  resolveTools: () => ToolDefinition[];
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
}

interface ToolUseSessionExec<C> {
  cycleOptions: ToolUseCycleOptions<C>;
  shouldSkipCycle: boolean;
  messages: ProviderMessage[];
  toolState: ToolState;
  clearSnapshot: boolean;
}

class ToolUseSessionSetupNode<C> extends Node<ToolUseRunShared<C>> {
  protected override async prep(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUseSessionPrep<C>> {
    return {
      agentPrompt: shared.agentPrompt,
      agentSetting: shared.agentSetting,
      agentConfig: shared.agentConfig,
      modelHandler: shared.modelHandler,
      toolRegistry: shared.toolRegistry,
      logger: shared.logger,
      resumeSnapshot: shared.getResumeSnapshot(),
      getUserVars: shared.getUserVars,
      initAgent: shared.initAgent,
      initializeClient: shared.initializeClient,
      getClientInstance: shared.getClientInstance,
      resolveTools: shared.resolveTools,
      checkInterruption: shared.checkInterruption,
      setAbortController: shared.setAbortController,
    };
  }

  protected override async exec(
    prepRes: ToolUseSessionPrep<C>,
  ): Promise<ToolUseSessionExec<C>> {
    const {
      agentPrompt,
      agentSetting,
      agentConfig,
      modelHandler,
      toolRegistry,
      logger,
      resumeSnapshot,
      getUserVars,
      initAgent,
      initializeClient,
      getClientInstance,
      resolveTools,
      checkInterruption,
      setAbortController,
    } = prepRes;

    await initAgent();
    await initializeClient();

    const userVars = getUserVars();
    let shouldSkipCycle = false;
    let messages: ProviderMessage[];
    let toolState: ToolState;
    let clearSnapshot = false;

    if (resumeSnapshot) {
      logger.info('Resuming tool-use session from saved state.');

      const snapshotMessages = resumeSnapshot.messages ?? [];
      if (!Array.isArray(snapshotMessages)) {
        throw new Error('Invalid snapshot: messages must be an array');
      }

      messages = snapshotMessages as ProviderMessage[];
      toolState =
        ToolUseSessionManager.hydrateToolStateFromSnapshot(resumeSnapshot);
      shouldSkipCycle = true;
      clearSnapshot = true;
    } else {
      const systemPrompt = await getSystemPromptWithRules(
        `${agentPrompt.systemPrompt}\n${TOOL_USE_INSTRUCTIONS}`,
        userVars,
      );
      const [userRequest, userPrefix] = await Promise.all([
        renderPrompt(agentPrompt.userRequest, userVars),
        renderPrompt(agentPrompt.userPrefix, userVars),
      ]);

      messages = await modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined,
        systemPrompt,
      );
      toolState = new ToolState();
    }

    const resolvedSetting: AgentSetting = {
      ...agentSetting,
      tools: resolveTools(),
    };

    const cycleOptions: ToolUseCycleOptions<C> = {
      modelHandler,
      agentSetting: resolvedSetting,
      agentPrompt,
      userVars,
      logger,
      client: getClientInstance(),
      toolRegistry,
      checkInterruption: () => checkInterruption(),
      setAbortController,
      toolState,
      modelName: agentConfig.model,
    };

    return {
      cycleOptions,
      shouldSkipCycle,
      messages,
      toolState,
      clearSnapshot,
    };
  }

  protected override async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseSessionPrep<C>,
    execRes: ToolUseSessionExec<C>,
  ): Promise<string | undefined> {
    shared.cycleOptions = execRes.cycleOptions;
    shared.shouldSkipCycle = execRes.shouldSkipCycle;
    shared.setMessages(execRes.messages);
    shared.setToolState(execRes.toolState);
    if (execRes.clearSnapshot) {
      shared.setResumeSnapshot(null);
    }
    return undefined;
  }
}

class ToolUseCycleNode<C> extends Node<ToolUseRunShared<C>> {
  protected override async exec(
    shared: ToolUseRunShared<C>,
  ): Promise<'skip' | 'run'> {
    if (!shared.cycleOptions) {
      throw new Error('Tool-use cycle options have not been initialised');
    }

    if (shared.shouldSkipCycle) {
      return 'skip';
    }

    await runToolUseCycle(shared.cycleOptions, shared.getMessages());
    return 'run';
  }

  protected override async post(
    shared: ToolUseRunShared<C>,
    _prepRes: unknown,
    execRes: 'skip' | 'run',
  ): Promise<string> {
    shared.shouldSkipCycle = false;

    if (shared.checkInterruption()) {
      return 'stop';
    }

    return 'wait';
  }
}

interface FollowUpPrep {
  hasQueuedFollowUp: boolean;
  waitForFollowUp: () => Promise<string | null>;
  enterWaitingState: () => Promise<void>;
  clearPersistedSnapshot: () => Promise<void>;
}

interface FollowUpExec {
  followUp: string | null;
}

class ToolUseFollowUpNode<C> extends Node<ToolUseRunShared<C>> {
  protected override async prep(
    shared: ToolUseRunShared<C>,
  ): Promise<FollowUpPrep> {
    return {
      hasQueuedFollowUp: shared.hasQueuedFollowUp(),
      waitForFollowUp: shared.waitForFollowUp,
      enterWaitingState: shared.enterWaitingState,
      clearPersistedSnapshot: shared.clearPersistedSnapshot,
    };
  }

  protected override async exec(prepRes: FollowUpPrep): Promise<FollowUpExec> {
    if (prepRes.hasQueuedFollowUp) {
      await prepRes.clearPersistedSnapshot();
    } else {
      await prepRes.enterWaitingState();
    }

    const followUp = await prepRes.waitForFollowUp();
    return { followUp };
  }

  protected override async post(
    shared: ToolUseRunShared<C>,
    _prepRes: FollowUpPrep,
    execRes: FollowUpExec,
  ): Promise<string> {
    if (!execRes.followUp || shared.checkInterruption()) {
      return 'stop';
    }

    await shared.markRunning();
    await shared.clearPersistedSnapshot();
    shared.logUserMessage(execRes.followUp);

    const updated = await shared.createUserFollowUpMessages(
      shared.getMessages(),
      execRes.followUp,
    );
    shared.setMessages(updated);

    return 'cycle';
  }
}

export function createToolUseFlow<C>(): Flow<ToolUseRunShared<C>> {
  const setup = new ToolUseSessionSetupNode<C>();
  const cycle = new ToolUseCycleNode<C>();
  const followUp = new ToolUseFollowUpNode<C>();

  setup.next(cycle);
  cycle.on('wait', followUp);
  followUp.on('cycle', cycle);

  return new Flow<ToolUseRunShared<C>>(setup);
}
