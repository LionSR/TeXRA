// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local imports - agent components
import type { AgentStateRound } from '@agent/core/AgentState';
import type { ToolState } from '@agent/core/ToolState';
import type { ReflectionRoundResult } from '../BaseReflectionAgent';

interface RoundPreparationResult {
  stateRound: AgentStateRound;
  preparedMessages: any[];
  prefill?: string;
  skip: boolean;
}

interface ReflectionRoundPipelineInput {
  stateRound: AgentStateRound;
  preparedMessages: any[];
  prefill: string;
}

export interface ReflectionRoundHooks {
  prepareToolState(): Promise<void>;
  prepareRoundContext(): Promise<RoundPreparationResult>;
  runRoundPipeline(
    input: ReflectionRoundPipelineInput,
  ): Promise<ReflectionRoundResult>;
  createSkipResult(stateRound: AgentStateRound): ReflectionRoundResult;
}

export interface ReflectionRoundRuntime {
  toolState: ToolState;
  roundState?: AgentStateRound;
  preparedMessages?: any[];
  prefill?: string;
  result?: ReflectionRoundResult;
}

export interface ReflectionRoundShared {
  runtime: ReflectionRoundRuntime;
  hooks: ReflectionRoundHooks;
}

class ToolPreparationNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundHooks> {
    return shared.hooks;
  }

  async exec(hooks: ReflectionRoundHooks): Promise<void> {
    await hooks.prepareToolState();
  }
}

interface RoundPreparationExec {
  stateRound: AgentStateRound;
  preparedMessages: any[];
  prefill?: string;
  skip: boolean;
}

class RoundPreparationNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundHooks> {
    return shared.hooks;
  }

  async exec(hooks: ReflectionRoundHooks): Promise<RoundPreparationExec> {
    return await hooks.prepareRoundContext();
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundHooks,
    execRes: RoundPreparationExec,
  ): Promise<string | undefined> {
    shared.runtime.roundState = execRes.stateRound;
    shared.runtime.preparedMessages = execRes.preparedMessages;
    shared.runtime.prefill = execRes.prefill ?? '';

    return execRes.skip ? FlowTransition.SKIP : FlowTransition.EXECUTE;
  }
}

class RoundExecutionNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundShared> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared): Promise<ReflectionRoundResult> {
    const { runtime, hooks } = shared;
    if (!runtime.roundState || !runtime.preparedMessages) {
      throw new Error('Round execution requires prepared round data.');
    }

    return await hooks.runRoundPipeline({
      stateRound: runtime.roundState,
      preparedMessages: runtime.preparedMessages,
      prefill: runtime.prefill ?? '',
    });
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundShared,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    shared.runtime.result = execRes;
    return undefined;
  }
}

class RoundSkipNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundShared> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared): Promise<ReflectionRoundResult> {
    const { runtime, hooks } = shared;
    if (!runtime.roundState) {
      throw new Error('Skip handling requires the current round state.');
    }

    return hooks.createSkipResult(runtime.roundState);
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundShared,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    shared.runtime.result = execRes;
    return undefined;
  }
}

export function createReflectionRoundFlow(): Flow<ReflectionRoundShared> {
  const toolPreparation = new ToolPreparationNode();
  const roundPreparation = new RoundPreparationNode();
  const roundExecution = new RoundExecutionNode();
  const roundSkip = new RoundSkipNode();

  toolPreparation.next(roundPreparation);
  roundPreparation.on(FlowTransition.EXECUTE, roundExecution);
  roundPreparation.on(FlowTransition.SKIP, roundSkip);

  return new Flow<ReflectionRoundShared>(toolPreparation);
}
