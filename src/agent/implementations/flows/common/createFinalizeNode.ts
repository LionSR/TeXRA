/**
 * Finalize node factory - creates nodes for agent flow finalization.
 *
 * This module consolidates:
 * - Finalize lifecycle error handling (formerly finalizeLifecycle.ts)
 * - Finalize node creation factories
 * - Context types for finalization
 */

// Core imports
import { BaseNode } from '@agent/node';

// Constants
import { END_GROUP_STATUS } from '@logger/messageTypes';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Types
// ============================================================================

/**
 * Context passed to finalize node callbacks.
 */
export interface FinalizeNodeContext<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object = object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}

/**
 * Shared state constraint for finalize nodes.
 */
interface FinalizeShared<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}

/** Helper type to extract context from shared */
type FinalizeContext<Shared extends FinalizeShared<any, any, any>> =
  FinalizeNodeContext<Shared['lifecycle'], Shared['hooks'], Shared['agent']>;

// ============================================================================
// Finalize Lifecycle (internal - formerly separate file)
// ============================================================================

interface FinalizeLifecycleOptions<Phase extends string> {
  lifecycle: AgentLifecycle<Phase>;
  runFinalize: () => Promise<void>;
  runCleanup: () => Promise<void>;
  onSuccess: () => void;
  onSecondaryError?: (error: unknown) => void;
}

/**
 * Runs finalization with proper error aggregation.
 * Primary error is preserved; secondary errors reported via callback.
 */
async function finalizeLifecycle<Phase extends string>({
  lifecycle,
  runFinalize,
  runCleanup,
  onSuccess,
  onSecondaryError,
}: FinalizeLifecycleOptions<Phase>): Promise<void> {
  const errors: unknown[] = [];
  if (lifecycle.error) {
    errors.push(lifecycle.error);
  }

  try {
    await runFinalize();
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 1 && onSecondaryError) {
    errors.slice(1).forEach((error) => onSecondaryError(error));
  }

  const primaryError = errors[0];
  if (primaryError) {
    lifecycle.fail(primaryError);
    return;
  }

  onSuccess();
}

// ============================================================================
// Finalize Node Factories
// ============================================================================

export interface AgentFinalizeNodeOptions<
  Shared extends FinalizeShared<any, any, any>,
  Status extends string = string,
> {
  finalizePhase: Shared['lifecycle']['phase'];
  computeStatus(context: FinalizeContext<Shared>): Status;
  runFinalize(context: FinalizeContext<Shared>, status: Status): Promise<void>;
  runCleanup(context: FinalizeContext<Shared>): Promise<void>;
  onSuccess?(context: FinalizeContext<Shared>): void | Promise<void>;
  onSecondaryError?(context: FinalizeContext<Shared>, error: unknown): void;
}

/**
 * Creates a fully customizable finalize node.
 */
export function createAgentFinalizeNode<
  Shared extends FinalizeShared<any, any, any>,
  Status extends string = string,
>(options: AgentFinalizeNodeOptions<Shared, Status>): BaseNode<Shared> {
  return new (class extends BaseNode<Shared> {
    async prep(shared: Shared): Promise<FinalizeContext<Shared>> {
      shared.lifecycle.setPhase(options.finalizePhase);
      return {
        lifecycle: shared.lifecycle,
        hooks: shared.hooks,
        agent: shared.agent,
      };
    }

    async exec(context: FinalizeContext<Shared>): Promise<void> {
      const status = options.computeStatus(context);
      await finalizeLifecycle({
        lifecycle: context.lifecycle,
        runFinalize: () => options.runFinalize(context, status),
        runCleanup: () => options.runCleanup(context),
        onSuccess: options.onSuccess
          ? () => options.onSuccess?.(context)
          : () => {},
        onSecondaryError: options.onSecondaryError
          ? (error) => options.onSecondaryError?.(context, error)
          : undefined,
      });
    }
  })();
}

/**
 * Options for the standard finalize node pattern.
 */
export interface StandardFinalizeNodeOptions<
  Shared extends FinalizeShared<any, any, any>,
> {
  finalizePhase: Shared['lifecycle']['phase'];
  beforeEnd?(context: FinalizeContext<Shared>): Promise<void>;
  onSecondaryError?(context: FinalizeContext<Shared>, error: unknown): void;
}

/**
 * Creates a standard finalize node with common patterns pre-configured.
 *
 * Pattern:
 * - Status: 'error' if lifecycle has error, otherwise 'stopped'
 * - Finalize: optional beforeEnd → hooks.end(status)
 * - Cleanup: hooks.cleanup()
 * - Success: lifecycle.complete()
 */
export function createStandardFinalizeNode<
  Shared extends FinalizeShared<any, any, any>,
>(options: StandardFinalizeNodeOptions<Shared>): BaseNode<Shared> {
  return createAgentFinalizeNode<Shared, 'error' | 'stopped'>({
    finalizePhase: options.finalizePhase,
    computeStatus: ({ lifecycle }) =>
      lifecycle.error || lifecycle.status === 'error'
        ? END_GROUP_STATUS.ERROR
        : END_GROUP_STATUS.STOPPED,
    runFinalize: async (context, status) => {
      if (options.beforeEnd) {
        await options.beforeEnd(context);
      }
      await context.hooks.end(status);
    },
    runCleanup: async ({ hooks }) => {
      await hooks.cleanup();
    },
    onSuccess: ({ lifecycle }) => {
      lifecycle.complete();
    },
    onSecondaryError: options.onSecondaryError,
  });
}
