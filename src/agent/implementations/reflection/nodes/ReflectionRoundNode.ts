import { Node } from '@agent/core/nodes/Node';
import type { AgentConfig, AgentPrompt, AgentSetting } from '@agent/core';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { runResponseCycle } from '@agent/core/ResponseCycle';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';

import type { RoundOutputOptions } from '../types';

interface ReflectionRoundDependencies {
  modelHandler: IModelHandler;
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  logger: AgentLogger;
  client: any;
  executionId?: ExecutionId;
  checkInterruption: () => boolean | Promise<boolean>;
  setAbortController: (controller: AbortController | null) => void;
  handleRoundCompletion: (
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ) => Promise<void>;
}

export interface ReflectionRoundShared {
  currRound: number;
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  messages: ProviderMessage[];
  prefill: string;
  outputPath: string;
  roundGroupId: string;
}

interface ReflectionRoundPreparation {
  endTurn: boolean;
  messages: ProviderMessage[];
}

export interface ReflectionRoundResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  messages: ProviderMessage[];
  endTurn: boolean;
  toolState: ToolState;
}

export class ReflectionRoundNode extends Node<
  ReflectionRoundPreparation,
  ReflectionRoundResult,
  ReflectionRoundShared
> {
  constructor(private readonly deps: ReflectionRoundDependencies) {
    super();
  }

  protected override async prep(
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundPreparation> {
    const { modelHandler, agentConfig, agentSetting } = this.deps;

    const [endTurn, updatedMessages] =
      await modelHandler.initializeOutputAndPrefill(
        agentConfig,
        agentSetting,
        shared.messages,
        shared.toolState,
        shared.outputPath,
        shared.prefill,
        shared.roundGroupId,
      );

    return {
      endTurn,
      messages: updatedMessages,
    };
  }

  protected override async exec(
    prepResult: ReflectionRoundPreparation,
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundResult> {
    if (prepResult.endTurn) {
      return {
        stateRound: shared.stateRound,
        stateGlobal: shared.stateGlobal,
        messages: prepResult.messages,
        endTurn: true,
        toolState: shared.toolState,
      };
    }

    const [
      updatedStateRound,
      updatedStateGlobal,
      updatedToolState,
      newEndTurn,
    ] = await runResponseCycle(
      {
        modelHandler: this.deps.modelHandler,
        agentSetting: this.deps.agentSetting,
        agentConfig: this.deps.agentConfig,
        agentPrompt: this.deps.agentPrompt,
        userVars: this.deps.userVars,
        logger: this.deps.logger,
        client: this.deps.client,
        checkInterruption: () => this.deps.checkInterruption(),
        setAbortController: this.deps.setAbortController,
      },
      prepResult.messages,
      shared.stateRound,
      shared.stateGlobal,
      shared.toolState,
      shared.outputPath,
      shared.roundGroupId,
      this.deps.executionId,
    );

    return {
      stateRound: updatedStateRound,
      stateGlobal: updatedStateGlobal,
      messages: prepResult.messages,
      endTurn: newEndTurn,
      toolState: updatedToolState,
    };
  }

  protected override async post(
    execResult: ReflectionRoundResult,
    prepResult: ReflectionRoundPreparation,
    shared: ReflectionRoundShared,
  ): Promise<ReflectionRoundResult> {
    await this.deps.handleRoundCompletion(
      shared.currRound,
      execResult.stateRound,
      execResult.stateGlobal,
      {
        outputFile: shared.outputPath,
        endTurn: execResult.endTurn,
        processGroupId: shared.roundGroupId,
      },
    );

    if (shared.currRound === 0 && !prepResult.endTurn) {
      this.deps.logger.debug(
        `stateGlobal: ${JSON.stringify(execResult.stateGlobal)}`,
        shared.roundGroupId,
      );
    }

    return execResult;
  }
}
