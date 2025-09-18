// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import type { RoundOutputOptions } from '@agent/implementations/BaseReflectionAgent';
import type { IModelHandler } from '@agent/modelHandlers';
import type { IOutputHandler } from '@agent/output';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';

// Local imports - core
import { Node } from '@agent/core/nodes/Node';
import { ToolState } from '@agent/core/ToolState';

// Local imports - latex utils
import { LatexMediaManager } from '@latex';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

type RunResponseCycle =
  typeof import('@agent/core/ResponseCycle').runResponseCycle;

interface ReflectionRoundNodeDependencies {
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  modelHandler: IModelHandler;
  outputHandler: IOutputHandler;
  latexMediaManager: LatexMediaManager;
  getPromptBuilder: () => PromptBuilder;
  logger: AgentLogger;
  handleRoundCompletion: (
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ) => Promise<void>;
  client: any;
  runResponseCycle: RunResponseCycle;
  executionId?: ExecutionId;
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
}

export type ReflectionRoundResult = [
  AgentStateRound,
  AgentStateGlobal,
  ProviderMessage[],
  boolean,
  ToolState,
];

interface ReflectionRoundPreparation {
  stateRound: AgentStateRound;
  messagesForModel: ProviderMessage[];
  prefill: string;
  outputPath: string;
  skip: boolean;
  skipResult?: ReflectionRoundResult;
  execution?: ReflectionRoundExecResult;
}

interface ReflectionRoundExecResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  messages: ProviderMessage[];
  endTurn: boolean;
  toolState: ToolState;
  skip: boolean;
}

export interface ReflectionRoundShared {
  currRound: number;
  stateGlobal: AgentStateGlobal;
  messages: ProviderMessage[];
  toolState: ToolState;
  roundGroupId: string;
  outputPath: string;
}

export class ReflectionRoundNode extends Node<
  ReflectionRoundPreparation,
  ReflectionRoundResult,
  ReflectionRoundShared
> {
  constructor(private readonly deps: ReflectionRoundNodeDependencies) {
    super();
  }

  protected async prep(
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundPreparation> {
    const { currRound, toolState, messages, roundGroupId, outputPath } = shared;
    const stateRound = new AgentStateRound(currRound);

    if (currRound === 0) {
      const inputFiles = [
        this.deps.agentConfig.inputFile,
        ...(this.deps.agentConfig.inputFiles || []),
      ];

      const extraMedia: string[] = [];
      if (this.deps.modelHandler.capabilities.supportsVision) {
        if (
          this.deps.agentConfig.mediaFile &&
          !toolState.mediaFiles.includes(this.deps.agentConfig.mediaFile)
        ) {
          extraMedia.push(this.deps.agentConfig.mediaFile);
        }
        if (this.deps.agentConfig.mediaFiles) {
          extraMedia.push(...this.deps.agentConfig.mediaFiles);
        }
      }

      await this.deps.latexMediaManager.processInputFiles(
        inputFiles,
        toolState,
        this.deps.agentConfig.toolConfig,
        this.deps.modelHandler.capabilities.supportsVision,
        extraMedia,
        roundGroupId,
      );

      const promptBuilder = this.deps.getPromptBuilder();
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      let prefixWithStats = userPrefix;
      if (toolState.texcountStats) {
        prefixWithStats = `${toolState.texcountStats}${userPrefix}`;
      }

      if (this.deps.agentConfig.toolConfig.printInputPrompt) {
        await writePromptToXml(
          systemPrompt,
          prefixWithStats,
          userRequest,
          this.deps.agentConfig.inputFile,
          this.deps.agentConfig.agent,
        );
      }

      const initialMessages = await this.deps.modelHandler.initializeMessages(
        prefixWithStats,
        userRequest,
        toolState.mediaFiles,
        systemPrompt,
      );

      const prefill = await promptBuilder.buildPrefill(currRound);
      toolState.updateAccumulatedOutput(prefill);

      return {
        stateRound,
        messagesForModel: initialMessages,
        prefill,
        outputPath,
        skip: false,
      };
    }

    await this.prepareToolStateForReflection(
      currRound,
      toolState,
      roundGroupId,
    );

    const promptBuilder = this.deps.getPromptBuilder();
    const userRequestReflect =
      await promptBuilder.buildReflectPrompt(currRound);
    let userMessage = userRequestReflect ? `${userRequestReflect}\n` : '';
    if (toolState.texcountStats) {
      userMessage = `${toolState.texcountStats}${userMessage}`;
    }

    if (!userMessage.trim()) {
      return {
        stateRound,
        messagesForModel: messages,
        prefill: '',
        outputPath,
        skip: true,
        skipResult: [stateRound, shared.stateGlobal, messages, true, toolState],
      };
    }

    const roundMessages = await this.deps.modelHandler.createRoundMessages(
      messages,
      userMessage,
      toolState.mediaFiles,
    );

    const prefill = await promptBuilder.buildPrefill(currRound);
    toolState.updateAccumulatedOutput(prefill);

    return {
      stateRound,
      messagesForModel: roundMessages,
      prefill,
      outputPath,
      skip: false,
    };
  }

  protected async exec(
    prepResult: ReflectionRoundPreparation,
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundResult> {
    if (prepResult.skip && prepResult.skipResult) {
      const result = prepResult.skipResult;
      const execution: ReflectionRoundExecResult = {
        stateRound: result[0],
        stateGlobal: result[1],
        messages: result[2],
        endTurn: result[3],
        toolState: result[4],
        skip: true,
      };
      prepResult.execution = execution;
      return result;
    }

    const [endTurn, updatedMessages] =
      await this.deps.modelHandler.initializeOutputAndPrefill(
        this.deps.agentConfig,
        this.deps.agentSetting,
        prepResult.messagesForModel,
        shared.toolState,
        prepResult.outputPath,
        prepResult.prefill,
        shared.roundGroupId,
      );

    if (!endTurn) {
      const [
        updatedStateRound,
        updatedStateGlobal,
        updatedToolState,
        newEndTurn,
      ] = await this.deps.runResponseCycle(
        {
          modelHandler: this.deps.modelHandler,
          agentSetting: this.deps.agentSetting,
          agentConfig: this.deps.agentConfig,
          agentPrompt: this.deps.agentPrompt,
          userVars: this.deps.userVars,
          logger: this.deps.logger,
          client: this.deps.client,
          checkInterruption: () => this.deps.checkInterruption(),
          setAbortController: (ctrl) => {
            this.deps.setAbortController(ctrl);
          },
        },
        updatedMessages,
        prepResult.stateRound,
        shared.stateGlobal,
        shared.toolState,
        prepResult.outputPath,
        shared.roundGroupId,
        this.deps.executionId,
      );

      const execution: ReflectionRoundExecResult = {
        stateRound: updatedStateRound,
        stateGlobal: updatedStateGlobal,
        messages: updatedMessages,
        endTurn: newEndTurn,
        toolState: updatedToolState,
        skip: false,
      };
      prepResult.execution = execution;
      return [
        execution.stateRound,
        execution.stateGlobal,
        execution.messages,
        execution.endTurn,
        execution.toolState,
      ];
    }

    const execution: ReflectionRoundExecResult = {
      stateRound: prepResult.stateRound,
      stateGlobal: shared.stateGlobal,
      messages: updatedMessages,
      endTurn,
      toolState: shared.toolState,
      skip: false,
    };
    prepResult.execution = execution;
    return [
      execution.stateRound,
      execution.stateGlobal,
      execution.messages,
      execution.endTurn,
      execution.toolState,
    ];
  }

  protected async post(
    execResult: ReflectionRoundResult,
    prepResult: ReflectionRoundPreparation,
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundResult> {
    const execution = prepResult.execution;
    if (execution && !execution.skip) {
      await this.deps.handleRoundCompletion(
        shared.currRound,
        execution.stateRound,
        execution.stateGlobal,
        {
          outputFile: prepResult.outputPath,
          endTurn: execution.endTurn,
          processGroupId: shared.roundGroupId,
        },
      );

      if (shared.currRound === 0) {
        this.deps.logger.debug(
          `stateGlobal: ${JSON.stringify(execution.stateGlobal)}`,
          shared.roundGroupId,
        );
      }
    }

    return execResult;
  }

  private async prepareToolStateForReflection(
    currRound: number,
    toolState: ToolState,
    groupId: string,
  ): Promise<void> {
    if (this.deps.agentConfig.outputFiles) {
      await this.deps.latexMediaManager.processOutputFiles(
        this.deps.agentConfig.outputFiles,
        toolState,
        this.deps.agentConfig.toolConfig,
        this.deps.modelHandler.capabilities.supportsVision,
        groupId,
      );
      return;
    }

    const outputFiles = this.deps.outputHandler.outputFiles[currRound - 1];
    if (outputFiles && outputFiles.length > 0) {
      await this.deps.latexMediaManager.processOutputFiles(
        [outputFiles[0]],
        toolState,
        this.deps.agentConfig.toolConfig,
        this.deps.modelHandler.capabilities.supportsVision,
        groupId,
      );
    }
  }
}
