// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - agent components
import type { AgentStateGlobal } from '@agent/core/AgentState';
import type {
  BaseReflectionAgent,
  ReflectionRoundResult,
  ReflectionRoundContext,
} from '../BaseReflectionAgent';

export interface ReflectionRunState {
  totalRounds: number;
  currentRound: number;
  continueRounds: boolean;
  messages: any[];
  globalState: AgentStateGlobal;
}

export interface ReflectionRunShared<C = unknown> {
  agent: BaseReflectionAgent<C>;
  state: ReflectionRunState;
}

interface ReflectionRoundPrep<C> {
  agent: BaseReflectionAgent<C>;
  state: ReflectionRunState;
  shouldFinalize: boolean;
  roundIndex: number;
  messages: any[];
  globalState: AgentStateGlobal;
}

interface ReflectionRoundExec<C> extends ReflectionRoundPrep<C> {
  result: ReflectionRoundResult;
}

class ReflectionRoundNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<ReflectionRoundPrep<C>> {
    const { agent, state } = shared;
    const shouldFinalize =
      state.currentRound >= state.totalRounds ||
      (state.currentRound > 0 && !state.continueRounds) ||
      agent.isInterruptionRequested();

    return {
      agent,
      state,
      shouldFinalize,
      roundIndex: state.currentRound,
      messages: state.messages,
      globalState: state.globalState,
    };
  }

  async exec(
    prepRes: ReflectionRoundPrep<C>,
  ): Promise<ReflectionRoundPrep<C> | ReflectionRoundExec<C>> {
    if (prepRes.shouldFinalize) {
      return prepRes;
    }

    prepRes.agent.setCurrentRound(prepRes.roundIndex);

    const result = await prepRes.agent.runReflectionRound({
      roundIndex: prepRes.roundIndex,
      globalState: prepRes.state.globalState,
      messages: prepRes.state.messages,
    } satisfies ReflectionRoundContext);

    return {
      ...prepRes,
      result,
    };
  }

  async post(
    shared: ReflectionRunShared<C>,
    prepRes: ReflectionRoundPrep<C>,
    execRes: ReflectionRoundPrep<C> | ReflectionRoundExec<C>,
  ): Promise<string | undefined> {
    if (prepRes.shouldFinalize) {
      return 'finalize';
    }

    const { result } = execRes as ReflectionRoundExec<C>;
    shared.agent.roundStates.push(result.roundState);
    shared.agent.toolStates.push(result.toolState);
    shared.state.globalState = result.globalState;
    shared.state.messages = result.messages;
    shared.state.continueRounds = result.shouldContinue;
    shared.state.currentRound += 1;
    shared.state.globalState.incrementRounds();

    if (shared.agent.isInterruptionRequested()) {
      return 'finalize';
    }

    if (shared.state.currentRound >= shared.state.totalRounds) {
      return 'finalize';
    }

    if (!shared.state.continueRounds) {
      return 'finalize';
    }

    return 'continue';
  }
}

class ReflectionFinalizeNode<C> extends BaseNode<ReflectionRunShared<C>> {}

export function createReflectionRunFlow<C>(): Flow<ReflectionRunShared<C>> {
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = new ReflectionFinalizeNode<C>();

  roundNode.on('finalize', finalizeNode);
  roundNode.on('continue', roundNode);

  return new Flow<ReflectionRunShared<C>>(roundNode);
}
