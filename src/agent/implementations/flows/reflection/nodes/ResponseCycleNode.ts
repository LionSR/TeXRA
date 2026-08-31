import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  ConversationRoundStateSnapshotSchema,
  recordCycleMetrics,
} from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/state/AgentState';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { buildFailedRetryInfo } from '@common/errors/sdkError/providerErrorFormat';
import type { AgentFileLocation, RetryErrorInfo } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '../ResponseCycleFlow';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface CyclePrepInput {
  context: ProviderMessage[];
  outputLocation: AgentFileLocation;
  run: AgentRunStateSnapshot;
  workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

type CycleOutcome =
  | { outcome: 'completed'; endTurn: boolean }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; lastError: RetryErrorInfo };

export class ResponseCycleNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionServices
> {
  override async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
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
    // Minted fresh per attempt: this is a metrics accumulator the cycle sums
    // into and `recordCycleMetrics` charges to the run, so a round retried after a
    // cancel must not inherit the cancelled attempt's response time or usage.
    // Continuations still accumulate within the attempt (they loop inside the
    // inner flow), so `CONTINUE_LIMIT` bounds every unattended attempt; a
    // user-driven cancel+resume deliberately starts a fresh continuation
    // budget along with the fresh metrics rather than persisting the count.
    const round = ConversationRoundStateSnapshotSchema.parse({
      roundIndex: shared.currentRound,
    });

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

  override async exec(prepRes: CyclePrepInput): Promise<CycleOutcome> {
    const [outputAlreadyComplete, initializedMessages] =
      await this.services.modelCell.handler.initializeOutputAndPrefill(
        this.services.config,
        this.services.setting,
        prepRes.context,
        prepRes.workspace,
        prepRes.outputLocation,
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
    const modelHandler = this.services.modelCell.handler;

    try {
      const flow = createResponseCycleFlow();
      // The spread copies the model cell by reference, so the cycle's nodes
      // read the handler and provider client the run is live on rather than a
      // copy taken when the cycle started.
      flow.setServices({
        ...this.services,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
      });
      await flow.run(cycleShared);

      if (cycleShared.lastError) {
        return {
          outcome: 'failed',
          lastError: cycleShared.lastError,
        };
      }
      // A round is `cancelled` only when the run was genuinely interrupted,
      // read from the authoritative interrupt signal — the same one
      // `RoundPersistedFlow` uses for its run-outcome, round-loop, and
      // step-loop decisions (resolveOutcome / shouldContinueNextRound /
      // executeRoundSteps). Any other stop (empty response, a stop reason not
      // recognized as end-of-turn, a token/continuation limit carrying real
      // output) keeps the round it already wrote. The `!endTurn` guard
      // preserves a cleanly-finished round even if an interrupt races in at
      // completion.
      if (this.services.runScope.signal.aborted && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', endTurn: cycleShared.endTurn };
    } catch (error) {
      recordCycleMetrics(
        prepRes.run,
        prepRes.round.responseTimeMs,
        prepRes.round.normalizedUsage,
      );
      await this.services.onRoundFinalized(prepRes.run);
      const err = ensureError(error);
      const { lastError } = buildFailedRetryInfo(err);
      this.services.logger.error(`Response cycle failed: ${err.message}`);
      return { outcome: 'failed', lastError };
    } finally {
      if (cycleShared.contextWindowRecoveryRequestId !== undefined) {
        modelHandler.clearCompactionRequest(
          cycleShared.contextWindowRecoveryRequestId,
        );
      }
    }
  }

  override async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleOutcome> {
    const { lastError } = buildFailedRetryInfo(error);
    this.services.logger.error(`Response cycle failed: ${error.message}`);
    return { outcome: 'failed', lastError };
  }

  override async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleOutcome,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    shared.outputLocation = prepRes.outputLocation;

    if (execRes.outcome === 'failed') {
      // Inner invocation failures are logged by RetryState. Exceptions from
      // this outer cycle are logged where catch/execFallback convert them.
      shared.lastError = execRes.lastError;
      shared.continueRounds = false;
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    shared.endTurn = execRes.outcome === 'completed' ? execRes.endTurn : false;

    if (execRes.outcome === 'cancelled') {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.lastError = undefined;
      // Keep the cursor on this node. Resume clears the cancellation-only
      // latch at hydration and retries the interrupted response instead of
      // skipping ahead to output with an incomplete model turn.
      return FlowTransition.WAITING;
    }

    shared.lastError = undefined;
    shared.workspaceSnapshot = prepRes.workspace.toSnapshot({
      excludeAssemblyStrings: true,
    });

    return FlowTransition.DEFAULT;
  }
}
