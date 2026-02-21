import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { recordRound } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import { formatProviderHttpError } from '@common/errors';
import type { ProviderError } from '@shared/schemas';
import type { AgentFileLocation } from '@utils/files';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

interface CyclePrepInput {
  shared: ReflectionFlowShared;
  outputLocation: AgentFileLocation;
  run: AgentRunStateSnapshot;
  workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

type CycleOutcome =
  | { outcome: 'completed'; endTurn: boolean }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: ProviderError };

export class ResponseCycleNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const { context } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    const workspace = AgentWorkspaceState.fromSnapshot(
      shared.workspaceSnapshot,
    );
    const run = shared.runStateSnapshot;
    const round = context.stateRoundSnapshot;

    return {
      shared,
      outputLocation: this.services.getOutputFileLocation(shared.currentRound),
      round,
      run,
      workspace,
    };
  }

  async exec(prepRes: CyclePrepInput): Promise<CycleOutcome> {
    const { shared } = prepRes;
    const context = shared.context!; // Validated in prep()

    const [prefillEndsTurn, initializedMessages] =
      await this.services.modelHandler.initializeOutputAndPrefill(
        this.services.config,
        this.services.setting,
        context.messages,
        prepRes.workspace,
        prepRes.outputLocation,
        context.prefill,
      );

    if (prefillEndsTurn) {
      return { outcome: 'completed', endTurn: true };
    }

    try {
      const cycleShared: ResponseCycleShared = {
        messages: initializedMessages,
        outputLocation: prepRes.outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
      };

      const flow = createResponseCycleFlow<C>();
      flow.setServices(
        await buildCycleServices(this.services, {
          round: prepRes.round,
          run: prepRes.run,
          workspace: prepRes.workspace,
        }),
      );
      await flow.run(cycleShared);

      if (cycleShared.lastError) {
        return {
          outcome: 'failed',
          error: cycleShared.lastError,
        };
      }
      if (cycleShared.shouldStop && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', endTurn: cycleShared.endTurn };
    } catch (error) {
      recordRound(prepRes.run, prepRes.round);
      if (this.services.onRoundFinalized) {
        await this.services.onRoundFinalized(prepRes.run);
      }
      return {
        outcome: 'failed',
        error: formatProviderHttpError(error),
      };
    }
  }

  async execFallback(
    _prepRes: CyclePrepInput,
    error: unknown,
  ): Promise<CycleOutcome> {
    return { outcome: 'failed', error: formatProviderHttpError(error) };
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleOutcome,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    shared.outputLocation = prepRes.outputLocation;

    if (execRes.outcome === 'failed') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      shared.lastError = execRes.error;
      shared.continueRounds = false;
      shared.endTurn = false;
      return FlowTransition.FINALIZE;
    }

    shared.endTurn = execRes.outcome === 'completed' ? execRes.endTurn : false;

    if (execRes.outcome === 'cancelled') {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.lastError = undefined;
      return FlowTransition.DEFAULT;
    }

    shared.lastError = undefined;
    shared.runStateSnapshot = prepRes.run;
    shared.workspaceSnapshot = prepRes.workspace.toSnapshot();
    shared.conversation = shared.context!.messages;
    shared.roundStateSnapshots.push(shared.context!.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
