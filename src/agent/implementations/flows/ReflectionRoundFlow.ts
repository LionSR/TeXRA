// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
// Local imports - agent components
import type { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type {
  BaseReflectionAgent,
  ReflectionRoundResult,
} from '@agent/implementations/BaseReflectionAgent';

interface RoundPreparationResult {
  stateRound: ConversationRoundState;
  preparedMessages: any[];
  prefill?: string;
  skip: boolean;
}

export interface ReflectionRoundContext {
  roundIndex: number;
  runState: AgentRunState;
  messages: any[];
  workspaceState: AgentWorkspaceState;
}

export interface ReflectionRoundRuntime {
  roundIndex: number;
  runState: AgentRunState;
  messages: any[];
  workspaceState: AgentWorkspaceState;
  roundState?: ConversationRoundState;
  preparedMessages?: any[];
  prefill?: string;
  result?: ReflectionRoundResult;
}

export interface ReflectionRoundShared<C = unknown> {
  agent: BaseReflectionAgent<C>;
  runtime: ReflectionRoundRuntime;
}

function storeRoundResult<C>(
  shared: ReflectionRoundShared<C>,
  result: ReflectionRoundResult,
): string | undefined {
  shared.runtime.result = result;
  return undefined;
}

class ToolPreparationNode<C> extends BaseNode<ReflectionRoundShared<C>> {
  async prep(
    shared: ReflectionRoundShared<C>,
  ): Promise<ReflectionRoundShared<C>> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared<C>): Promise<void> {
    // Call agent method directly - no hook indirection
    await shared.agent.prepareAgentWorkspaceState(
      shared.runtime.roundIndex,
      shared.runtime.workspaceState,
    );
  }
}

interface RoundPreparationExec {
  stateRound: ConversationRoundState;
  preparedMessages: any[];
  prefill?: string;
  skip: boolean;
}

class RoundPreparationNode<C> extends BaseNode<ReflectionRoundShared<C>> {
  async prep(
    shared: ReflectionRoundShared<C>,
  ): Promise<ReflectionRoundShared<C>> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared<C>): Promise<RoundPreparationExec> {
    // Call agent method directly - no hook indirection
    return await shared.agent.prepareRoundContext(
      shared.runtime.roundIndex,
      shared.runtime.runState,
      shared.runtime.messages,
      shared.runtime.workspaceState,
    );
  }

  async post(
    shared: ReflectionRoundShared<C>,
    _prepRes: ReflectionRoundShared<C>,
    execRes: RoundPreparationExec,
  ): Promise<string | undefined> {
    shared.runtime.roundState = execRes.stateRound;
    shared.runtime.preparedMessages = execRes.preparedMessages;
    shared.runtime.prefill = execRes.prefill ?? '';

    return execRes.skip ? FlowTransition.SKIP : FlowTransition.EXECUTE;
  }
}

class RoundExecutionNode<C> extends BaseNode<ReflectionRoundShared<C>> {
  async prep(
    shared: ReflectionRoundShared<C>,
  ): Promise<ReflectionRoundShared<C>> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared<C>): Promise<ReflectionRoundResult> {
    const { runtime, agent } = shared;
    if (!runtime.roundState || !runtime.preparedMessages) {
      throw new Error('Round execution requires prepared round data.');
    }

    const outputPath = agent.getOutputFile(runtime.roundIndex);

    // Call agent method directly - no hook indirection
    return await agent.runRoundPipeline({
      roundIndex: runtime.roundIndex,
      roundState: runtime.roundState,
      runState: runtime.runState,
      workspaceState: runtime.workspaceState,
      preparedMessages: runtime.preparedMessages,
      prefill: runtime.prefill ?? '',
      outputPath,
    });
  }

  async post(
    shared: ReflectionRoundShared<C>,
    _prepRes: ReflectionRoundShared<C>,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    return storeRoundResult(shared, execRes);
  }
}

class RoundSkipNode<C> extends BaseNode<ReflectionRoundShared<C>> {
  async prep(
    shared: ReflectionRoundShared<C>,
  ): Promise<ReflectionRoundShared<C>> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared<C>): Promise<ReflectionRoundResult> {
    const { runtime } = shared;
    if (!runtime.roundState) {
      throw new Error('Skip handling requires the current round state.');
    }

    // Return skip result directly - no hook needed
    return {
      roundState: runtime.roundState,
      runState: runtime.runState,
      messages: runtime.messages,
      shouldContinue: true,
      workspaceState: runtime.workspaceState,
      outputArtifacts: null,
    };
  }

  async post(
    shared: ReflectionRoundShared<C>,
    _prepRes: ReflectionRoundShared<C>,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    return storeRoundResult(shared, execRes);
  }
}

export function createReflectionRoundFlow<C>(): Flow<ReflectionRoundShared<C>> {
  const toolPreparation = new ToolPreparationNode<C>();
  const roundPreparation = new RoundPreparationNode<C>();
  const roundExecution = new RoundExecutionNode<C>();
  const roundSkip = new RoundSkipNode<C>();

  toolPreparation.next(roundPreparation);
  roundPreparation.on(FlowTransition.EXECUTE, roundExecution);
  roundPreparation.on(FlowTransition.SKIP, roundSkip);

  return new Flow<ReflectionRoundShared<C>>(toolPreparation);
}
