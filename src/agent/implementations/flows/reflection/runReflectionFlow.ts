/**
 * runReflectionFlow - Run reflection flows without agent class instances.
 *
 * ## Flow-First Architecture
 *
 * This module provides a direct way to run reflection flows, bypassing the
 * agent class hierarchy entirely. Instead of:
 *
 *   executeAgent → instantiate DirectAgent/CoTAgent → agent.run() → flow.run()
 *
 * We can now do:
 *
 *   runReflectionFlow(config) → flow.run() directly
 *
 * ## Usage:
 *
 * ```typescript
 * const result = await runReflectionFlow({
 *   modelHandler,
 *   config: agentConfig,
 *   setting: agentSetting,
 *   prompt: agentPrompt,
 *   executionContext,
 *   userVarChannels,
 * });
 * ```
 *
 * ## What This Replaces:
 *
 * - DirectAgent class (single round, scratchpad-conditional XML)
 * - CoTAgent class (multi-round, always XML)
 * - BaseReflectionAgent.run() method
 *
 * The agent type behavior is now determined by configuration fields:
 * - `setting.maxRounds`: Number of rounds (1 for direct-like behavior)
 * - `setting.xmlStructureMode`: 'never' | 'scratchpadOnly' | 'always'
 */

import type { RoundOutput } from '@agent/output';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { createRetryState } from '@agent/core/flows/RetryState';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

import {
  createReflectionFlow,
  type ReflectionFlowShared,
} from './ReflectionFlow';
import { createInitialReflectionState } from './ReflectionFlowState';
import {
  ReflectionFlowContext,
  type ReflectionFlowContextInit,
} from './ReflectionFlowContext';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a reflection flow.
 */
export interface RunReflectionFlowInput<C = unknown> extends Omit<
  ReflectionFlowContextInit<C>,
  'getUsageRecorder'
> {
  /**
   * Usage recorder callback. If not provided, usage is not tracked.
   */
  getUsageRecorder?: () => AgentRoundFinalizedCallback;

  /**
   * Optional: Pre-hydrated round outputs for resume functionality.
   */
  hydratedOutputs?: RoundOutput[];

  /**
   * Optional: Parent log stage for creating round stages.
   * If not provided, a new stage will be created.
   */
  parentStage?: AgentLogStage;
}

/**
 * Result from running a reflection flow.
 */
export interface RunReflectionFlowResult {
  /** Round outputs from the flow execution */
  roundOutputs: RoundOutput[];

  /** Status of the flow execution */
  status: EndGroupStatus;
}

/**
 * Callbacks for reflection flow lifecycle events.
 * Mirrors the pattern from runToolUseFlow for consistency.
 */
export interface RunReflectionFlowCallbacks {
  /**
   * Called when the flow context is ready for registration.
   * Use this to register the context with the interrupt registry.
   */
  onContextReady?: (
    storageKey: StorageKey,
    context: ReflectionFlowContext<unknown>,
  ) => void;

  /**
   * Called when the flow completes (success or error).
   * Use this to unregister from the interrupt registry.
   */
  onFlowComplete?: (storageKey: StorageKey) => void;
}

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Run a reflection flow directly without agent class instances.
 *
 * This is the flow-first replacement for:
 * - DirectAgent.run()
 * - CoTAgent.run()
 * - BaseReflectionAgent.run()
 *
 * @param input - Flow configuration and dependencies
 * @param callbacks - Optional lifecycle callbacks for interrupt registration
 * @returns Flow execution result
 */
export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
  callbacks?: RunReflectionFlowCallbacks,
): Promise<RunReflectionFlowResult> {
  const {
    modelHandler,
    config,
    setting,
    prompt,
    executionContext,
    userVarChannels,
    checkInterruption,
    setAbortController,
    getClient,
    getUsageRecorder = () => async () => {},
    hydratedOutputs,
    parentStage,
  } = input;

  // Create the flow context (owns all services)
  const flowContext = new ReflectionFlowContext({
    modelHandler,
    config,
    setting,
    prompt,
    executionContext,
    userVarChannels,
    checkInterruption,
    setAbortController,
    getClient,
    getUsageRecorder,
  });

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;
  let createdRunStage = false;
  const storageKey = executionContext.storageKey;

  try {
    // Reset prompt builder before run
    flowContext.resetPromptBuilder();

    // Update storage key for workflow agents
    flowContext.setActiveRun(storageKey);

    // Register context for interrupt handling
    callbacks?.onContextReady?.(storageKey, flowContext);

    // Create or use provided run stage
    const runStage =
      parentStage ??
      (await executionContext.logger.stage(`Run: ${config.agent}`, {
        skip: false,
      }));

    // Track if we created the stage internally
    createdRunStage = !parentStage;

    // Determine starting round from hydrated outputs (for resume)
    const hadHydratedRounds = hydratedOutputs && hydratedOutputs.length > 0;
    const startingRound = hadHydratedRounds ? hydratedOutputs.length : 0;

    // Create initial round stage for UI grouping (r0, r1, etc.)
    const roundStageName = `r${startingRound}`;
    const roundStage = await executionContext.logger.stage(roundStageName, {
      parent: runStage,
    });

    // Create shared state for the flow
    shared = {
      state: createInitialReflectionState(
        flowContext.totalRounds,
        AgentWorkspaceState.create(),
        hadHydratedRounds ? hydratedOutputs : undefined,
      ),
      retryState: createRetryState(),
      runStage,
    };

    // Set initial round stage
    shared.state.roundStage = roundStage;

    // Create flow and inject services
    const flow = createReflectionFlow<C>();
    flow.setServices(flowContext.services);

    // Run the flow - errors throw directly
    await flow.run(shared);

    status = END_GROUP_STATUS.STOPPED;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Finalize round stage
    shared?.state.roundStage?.end(status);

    // Finalize run stage if we created it internally
    if (createdRunStage && shared?.runStage) {
      shared.runStage.end(status);
    }

    // Unregister from interrupt registry
    callbacks?.onFlowComplete?.(storageKey);
  }

  return {
    roundOutputs: shared?.state.roundOutputs ?? [],
    status,
  };
}
