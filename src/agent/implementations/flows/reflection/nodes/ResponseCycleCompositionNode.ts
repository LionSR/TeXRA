/**
 * ResponseCycleCompositionNode - Composes ResponseCycleFlow as a sub-flow.
 *
 * This node demonstrates the key architectural change:
 * - Instead of calling `runResponseCycle()` function (hybrid pattern)
 * - We compose ResponseCycleFlow directly (pure flow pattern)
 *
 * Responsibilities:
 * - Create AgentSharedStore for the cycle
 * - Build ResponseCycleOptions from services
 * - Run ResponseCycleFlow as a sub-flow
 * - Extract results back to ReflectionFlowShared
 *
 * PocketFlow pattern:
 * - prep(): Build store and output location
 * - exec(): Run the composed sub-flow
 * - post(): Update shared state with results
 *
 * Services accessed via native `this.services`:
 * - modelHandler, logger, setting, prompt, config, context, etc.
 */

import { Node, Flow } from '@agent/node';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { ConversationRoundState } from '@agent/core/AgentState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from '@agent/core/flows/ResponseCycleFlow';
import {
  createRetryState,
  type RetryState,
} from '@agent/core/flows/RetryState';
import type {
  ResponseCycleOptions,
  ResponseCycleParams,
} from '@agent/core/flows/CycleServices';
import type { AgentFileLocation } from '@utils/files';

import type {
  ReflectionFlowShared,
  RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface CyclePrepInput {
  context: RoundContext;
  currentRound: number;
  outputLocation: AgentFileLocation;
  store: AgentSharedStore;
}

type CycleExecResult =
  | {
      kind: 'success';
      endTurn: boolean;
      store: AgentSharedStore;
      failedWithError: boolean;
      errorMessage?: string;
      userCancelled: boolean;
    }
  | { kind: 'error'; error: Error };

// ============================================================================
// Node Implementation
// ============================================================================

export class ResponseCycleCompositionNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  private cycleFlow: Flow<ResponseCycleShared, ResponseCycleParams<C>>;

  constructor() {
    super(1, 0); // maxRetries=1, wait=0
    this.cycleFlow = createResponseCycleFlow<C>();
  }

  /**
   * Build shared store and determine output location.
   */
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const {
      fileService,
      config,
      setting,
      userVarChannels,
      getOutputFileLocation,
    } = this.services;
    const { currentRound, context, workspaceState, runState } = shared.state;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Create shared store for cycle
    const store = new AgentSharedStore({
      round: context.stateRound,
      run: runState,
      workspace: workspaceState,
      user: userVarChannels,
    });

    // Determine output location for this round (delegates to agent for polymorphism)
    const outputLocation = getOutputFileLocation(currentRound);

    return {
      context,
      currentRound,
      outputLocation,
      store,
    };
  }

  /**
   * Run ResponseCycleFlow as a sub-flow.
   */
  async exec(prepRes: CyclePrepInput): Promise<CycleExecResult> {
    const services = this.services;

    // Build ResponseCycleOptions from our services
    const cycleOptions: ResponseCycleOptions<C> = {
      modelHandler: services.modelHandler,
      logger: services.logger,
      agentSetting: services.setting,
      agentPrompt: services.prompt,
      agentConfig: services.config,
      context: services.context,
      client: services.getClient(),
      userVars: this.getUserVars(),
      userVarChannels: services.userVarChannels,
      fileService: services.fileService,
      checkInterruption: services.checkInterruption,
      setAbortController: services.setAbortController,
    };

    // Create cycle shared state
    const cycleShared: ResponseCycleShared = {
      state: {
        messages: prepRes.context.messages,
        outputLocation: prepRes.outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
        systemPrompt: undefined,
        debugContext: undefined,
        debugFileOptions: undefined,
        startTime: undefined,
        responseObject: undefined,
        responseTime: undefined,
        stopReason: undefined,
        processedResponse: undefined,
        roundFinalized: false,
      } satisfies ResponseCycleState,
      retryState: createRetryState(),
    };

    try {
      // Inject services and run sub-flow
      this.cycleFlow.setParams({
        services: { options: cycleOptions, store: prepRes.store },
      });
      await this.cycleFlow.run(cycleShared);

      // Extract results from cycle shared state
      const failedWithError =
        cycleShared.state.shouldStop && !!cycleShared.retryState.lastError;
      const userCancelled =
        cycleShared.state.shouldStop &&
        !cycleShared.retryState.lastError &&
        !cycleShared.state.endTurn;

      return {
        kind: 'success',
        endTurn: cycleShared.state.endTurn,
        store: prepRes.store,
        failedWithError,
        errorMessage: cycleShared.retryState.lastError?.message,
        userCancelled,
      };
    } catch (error) {
      return {
        kind: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Handle cycle failure.
   */
  async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'error', error };
  }

  /**
   * Update shared state with cycle results.
   *
   * Errors are thrown directly - agent.run() catches and handles cleanup.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    if (execRes.kind === 'error') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      throw execRes.error;
    }

    if (execRes.userCancelled) {
      logger.debug('Response cycle cancelled by user');
      shared.state.continueRounds = false;
      // User cancellation is not an error - just stop gracefully
      return undefined;
    }

    if (execRes.failedWithError) {
      logger.error(`Response cycle failed: ${execRes.errorMessage}`);
      throw new Error(execRes.errorMessage ?? 'Unknown error');
    }

    // Update state from store
    shared.state.runState = execRes.store.run;
    shared.state.endTurn = execRes.endTurn;
    shared.state.outputLocation = prepRes.outputLocation;

    // Store round state for later
    shared.state.roundStates.push(prepRes.context.stateRound);

    // Continue to OutputNode
    return undefined;
  }

  /**
   * Get user variables for prompt rendering.
   */
  private getUserVars(): Record<string, any> {
    const channels = this.services.userVarChannels;
    return {
      ...channels.input,
      ...channels.transient,
      ...channels.output,
    };
  }
}
