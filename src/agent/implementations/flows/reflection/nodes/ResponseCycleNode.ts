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
import { formatProviderHttpError } from '@common/errors';
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
  | { outcome: 'failed'; error: Error; userRetryable?: boolean };

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
      const { modelHandler } = this.services;
      let client = await modelHandler.getClient();
      flow.setServices({
        ...this.services,
        get client() {
          return client;
        },
        async refreshClient() {
          client = await modelHandler.getClient();
        },
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
      });
      await flow.run(cycleShared);

      if (cycleShared.lastError) {
        return {
          outcome: 'failed',
          error: new Error(cycleShared.lastError.message),
          userRetryable: cycleShared.lastError.userRetryable,
        };
      }
      if (cycleShared.shouldStop && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', endTurn: cycleShared.endTurn };
    } catch (error) {
      recordRound(prepRes.run, prepRes.round);
      await this.services.onRoundFinalized(prepRes.run);
      const formatted = formatProviderHttpError(error);
      return {
        outcome: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        userRetryable: formatted.userRetryable,
      };
    }
  }

  async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleOutcome> {
    const formatted = formatProviderHttpError(error);
    return { outcome: 'failed', error, userRetryable: formatted.userRetryable };
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
      shared.lastError = {
        message: execRes.error.message,
        userRetryable: execRes.userRetryable ?? false,
      };
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
    shared.workspaceSnapshot = prepRes.workspace.toSnapshot({
      excludeAssemblyStrings: true,
    });
    shared.conversation = shared.context!.messages;
    shared.roundStateSnapshots.push(shared.context!.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
