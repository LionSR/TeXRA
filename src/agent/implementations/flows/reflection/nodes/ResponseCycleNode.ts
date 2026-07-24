import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { recordRound } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import { withModelClient } from '@agent/core/flows/CycleServices';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/state/AgentState';
import { buildFailedRetryInfo } from '@common/errors';
import type { AgentFileLocation, RetryErrorInfo } from '@shared/schemas';
import { getDefaultToolRegistry } from '@tools/registry';
import { ensureError } from '@utils/errors/errorMessage';

import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface CyclePrepInput {
  context: RoundContext;
  outputLocation: AgentFileLocation;
  run: AgentRunStateSnapshot;
  workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

type CycleOutcome =
  | { outcome: 'completed'; endTurn: boolean }
  | { outcome: 'cancelled' }
  | {
      outcome: 'failed';
      error: Error;
      userRetryable: boolean;
      lastError?: RetryErrorInfo;
      failureLogEmitted: boolean;
    };

export class ResponseCycleNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const { context } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // shared.workspaceSnapshot was produced by this same node's own
    // toSnapshot() last round (or by the flow's one-time resume hydration in
    // runReflectionFlow) — never raw persisted/legacy data — so re-deriving
    // it here uses the canonical-only path (see AgentWorkspaceState.fromCanonicalSnapshot).
    const workspace = AgentWorkspaceState.fromCanonicalSnapshot(
      shared.workspaceSnapshot,
    );
    const run = shared.runStateSnapshot;
    const round = context.stateRoundSnapshot;

    return {
      context,
      outputLocation: await this.services.getOutputFileLocation(
        shared.currentRound,
      ),
      round,
      run,
      workspace,
    };
  }

  async exec(prepRes: CyclePrepInput): Promise<CycleOutcome> {
    const { context } = prepRes;

    const [outputAlreadyComplete, initializedMessages] =
      await this.services.modelHandler.initializeOutputAndPrefill(
        this.services.config,
        this.services.setting,
        context.messages,
        prepRes.workspace,
        prepRes.outputLocation,
        '',
      );

    if (outputAlreadyComplete) {
      return { outcome: 'completed', endTurn: true };
    }

    const cycleShared: ResponseCycleShared = {
      messages: initializedMessages,
      outputLocation: prepRes.outputLocation,
      endTurn: false,
      shouldStop: false,
      outputExists: false,
    };
    const { modelHandler } = this.services;

    try {
      const flow = createResponseCycleFlow<C>();
      flow.setServices(
        await withModelClient(
          {
            ...this.services,
            toolRegistry: getDefaultToolRegistry(),
            round: prepRes.round,
            run: prepRes.run,
            workspace: prepRes.workspace,
          },
          modelHandler,
        ),
      );
      await flow.run(cycleShared);

      if (cycleShared.lastError) {
        return {
          outcome: 'failed',
          error: new Error(cycleShared.lastError.message),
          userRetryable: cycleShared.lastError.userRetryable,
          lastError: cycleShared.lastError,
          failureLogEmitted: cycleShared.failureLogEmitted ?? false,
        };
      }
      // A round is `cancelled` only when the run was genuinely interrupted —
      // sourced from the authoritative interrupt signal, the same one
      // `RoundPersistedFlow` already uses for its run-outcome, round-loop, and
      // step-loop decisions (resolveOutcome / shouldContinueNextRound /
      // executeRoundSteps). The previous `shouldStop && !endTurn` proxy
      // conflated three distinct cases — genuine interrupt, empty response, and
      // a completed response whose stop reason wasn't recognized as end-of-turn
      // — so any non-interrupt stop without `endTurn` discarded an
      // already-written round (e.g. a token/continuation-limit stop carrying
      // real output, or any provider whose terminal reason isn't yet mapped to
      // the canonical end-turn vocabulary). The `!endTurn` guard preserves a
      // cleanly-finished round even if an interrupt races in at completion.
      if (this.services.checkInterruption() && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', endTurn: cycleShared.endTurn };
    } catch (error) {
      recordRound(prepRes.run, prepRes.round);
      await this.services.onRoundFinalized(prepRes.run);
      return {
        outcome: 'failed',
        error: ensureError(error),
        failureLogEmitted: false,
        ...buildFailedRetryInfo(error),
      };
    } finally {
      if (cycleShared.contextWindowRecoveryRequestId !== undefined) {
        modelHandler.clearCompactionRequest(
          cycleShared.contextWindowRecoveryRequestId,
        );
      }
    }
  }

  async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleOutcome> {
    return {
      outcome: 'failed',
      error,
      failureLogEmitted: false,
      ...buildFailedRetryInfo(error),
    };
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleOutcome,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    shared.outputLocation = prepRes.outputLocation;

    if (execRes.outcome === 'failed') {
      if (!execRes.failureLogEmitted) {
        logger.error(`Response cycle failed: ${execRes.error.message}`);
      }
      shared.lastError = execRes.lastError ?? {
        message: execRes.error.message,
        userRetryable: execRes.userRetryable,
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
    shared.conversation = prepRes.context.messages;
    shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
