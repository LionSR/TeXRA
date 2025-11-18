// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
// Local imports - agent components
import type { AgentRunState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type {
  BaseReflectionAgent,
  ReflectionRoundResult,
} from '@agent/implementations/BaseReflectionAgent';

interface RoundPreparationResult {
  stateRound: any;
  preparedMessages: any[];
  prefill?: string;
  skip: boolean;
}

export interface ReflectionRoundContext {
  agent: BaseReflectionAgent;
  roundIndex: number;
  runState: AgentRunState;
  messages: any[];
  workspaceState: AgentWorkspaceState;
}

export interface ReflectionRoundShared {
  agent: BaseReflectionAgent;
  context: ReflectionRoundContext;
  runtime: {
    roundState?: any;
    preparedMessages?: any[];
    prefill?: string;
    result?: ReflectionRoundResult;
  };
}

function storeRoundResult(
  shared: ReflectionRoundShared,
  result: ReflectionRoundResult,
): string | undefined {
  shared.runtime.result = result;
  return undefined;
}

class ToolPreparationNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundContext> {
    return shared.context;
  }

  async exec(context: ReflectionRoundContext): Promise<void> {
    await context.agent.prepareAgentWorkspaceState(
      context.roundIndex,
      context.workspaceState,
    );
  }
}

class RoundPreparationNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundContext> {
    return shared.context;
  }

  async exec(
    context: ReflectionRoundContext,
  ): Promise<RoundPreparationResult> {
    return await context.agent.prepareRoundContext(
      context.roundIndex,
      context.runState,
      context.messages,
      context.workspaceState,
    );
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundContext,
    execRes: RoundPreparationResult,
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
    const { agent, context, runtime } = shared;
    if (!runtime.roundState || !runtime.preparedMessages) {
      throw new Error('Round execution requires prepared round data.');
    }

    return await agent.runRoundPipeline({
      roundIndex: context.roundIndex,
      roundState: runtime.roundState,
      runState: context.runState,
      workspaceState: context.workspaceState,
      preparedMessages: runtime.preparedMessages,
      prefill: runtime.prefill ?? '',
      outputLocation: agent.outputFile[context.roundIndex],
    });
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundShared,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    return storeRoundResult(shared, execRes);
  }
}

class RoundSkipNode extends BaseNode<ReflectionRoundShared> {
  async prep(shared: ReflectionRoundShared): Promise<ReflectionRoundShared> {
    return shared;
  }

  async exec(shared: ReflectionRoundShared): Promise<ReflectionRoundResult> {
    const { context, runtime } = shared;
    if (!runtime.roundState) {
      throw new Error('Skip handling requires the current round state.');
    }

    return {
      roundState: runtime.roundState,
      runState: context.runState,
      messages: context.messages,
      shouldContinue: true,
      workspaceState: context.workspaceState,
      output: null,
    };
  }

  async post(
    shared: ReflectionRoundShared,
    _prepRes: ReflectionRoundShared,
    execRes: ReflectionRoundResult,
  ): Promise<string | undefined> {
    return storeRoundResult(shared, execRes);
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
