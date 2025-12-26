/**
 * Init node - standard initialization node for agent flows.
 *
 * Execution order:
 * 1. exec(): Set 'init' lifecycle phase
 * 2. exec(): Call agent.startAndInitRun() for stage creation and agent initialization
 * 3. exec(): Call agent.initializeClient() for API client
 * 4. post(): Call beforeStart() hook (override in subclass for custom behavior)
 * 5. post(): Transition to next phase on success, finalize on error
 *
 * Lifecycle methods are called directly on the agent (IFlowAgent interface)
 * rather than through hooks, since they have identical implementations
 * across all agent types.
 *
 * Extension point (override in subclass):
 * - beforeStart(): Called after initialization completes but before phase transition.
 *   Runs in post() to have access to shared.hooks for flow-specific operations.
 */

import { Node, type NonIterableObject } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Type imports
import type { IFlowAgent } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';
import type { InitExecResult } from './AgentRunFlowRunner';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal shared state interface for StandardInitNode.
 * Looser than AgentRunShared to support flows without hooks.
 */
interface MinimalShared {
  agent: IFlowAgent;
  lifecycle: AgentLifecycle<string>;
}

/**
 * Prep result for StandardInitNode.
 * Contains agent and lifecycle needed for initialization.
 */
interface InitNodePrepResult<
  Agent extends IFlowAgent,
  Lifecycle extends AgentLifecycle<string>,
> {
  agent: Agent;
  lifecycle: Lifecycle;
}

/** Helper type to extract prep result from shared */
type PrepResultOf<Shared extends MinimalShared> = InitNodePrepResult<
  Shared['agent'],
  Shared['lifecycle']
>;

// ============================================================================
// StandardInitNode
// ============================================================================

/**
 * Standard init node with error handling and phase transitions.
 *
 * PocketFlow pattern:
 * - prep(): Extract agent and lifecycle from shared
 * - exec(): Run initialization sequence (errors throw naturally)
 * - execFallback(): Convert errors to result type
 * - post(): Transition phase on success, finalize on error
 *
 * Lifecycle methods are called directly on the agent (IFlowAgent interface),
 * not through hooks. This eliminates the redundant hook spreading pattern.
 *
 * Extension point (override in subclass):
 * - beforeStart(): Run operations before agent.startRun()
 *
 * @example
 * ```typescript
 * // Simple usage - specify next phase
 * const initNode = new StandardInitNode<MyShared>('prepare');
 *
 * // With customization - extend the class
 * class MyInitNode extends StandardInitNode<MyShared> {
 *   constructor() { super('rounds'); }
 *
 *   protected beforeStart(shared: MyShared): void {
 *     shared.hooks.resetPromptBuilder();
 *   }
 * }
 * ```
 */
export class StandardInitNode<
  Shared extends MinimalShared,
  Params extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends Node<Shared, Params, Svc> {
  /**
   * @param nextPhase Phase to transition to on successful initialization
   */
  constructor(protected readonly nextPhase: Shared['lifecycle']['phase']) {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: Shared): Promise<PrepResultOf<Shared>> {
    return { agent: shared.agent, lifecycle: shared.lifecycle };
  }

  /**
   * Override for pre-start operations (e.g., reset prompt builder).
   * Called before agent.startRun(). Has access to full shared state.
   */
  protected beforeStart(_shared: Shared): void {
    // Default: no-op
  }

  async exec(prepRes: PrepResultOf<Shared>): Promise<{ kind: 'success' }> {
    prepRes.lifecycle.begin('init');

    // Let errors throw - Node._exec catches them and calls execFallback
    // Lifecycle methods called directly on agent (IFlowAgent interface)
    await prepRes.agent.startAndInitRun();
    await prepRes.agent.initializeClient();

    return { kind: 'success' };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: unknown }> {
    return { kind: 'error', error };
  }

  async post(
    shared: Shared,
    _prepRes: unknown,
    execRes: InitExecResult,
  ): Promise<string | undefined> {
    // Call beforeStart here in post() since it may need to access hooks
    // which are flow-specific and available on shared
    if (execRes.kind === 'success') {
      this.beforeStart(shared);
    }

    if (execRes.kind === 'error') {
      shared.lifecycle.fail(execRes.error);
      return FlowTransition.FINALIZE;
    }
    shared.lifecycle.begin(this.nextPhase);
    return undefined; // Follow next() to the next node
  }
}
