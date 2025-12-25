/**
 * Init node - standard initialization node for agent flows.
 *
 * Handles the initialization pattern:
 * 1. Set 'init' lifecycle phase
 * 2. Run optional beforeStart() hook (override in subclass)
 * 3. Call hooks.start() to create log stage
 * 4. Call hooks.init() for agent initialization
 * 5. Call hooks.initializeClient() for API client
 * 6. Transition to next phase on success, finalize on error
 *
 * Extension point (override in subclass):
 * - beforeStart(): Run operations before hooks.start()
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';
import type { AgentRunShared, InitExecResult } from './AgentRunFlowRunner';

// ============================================================================
// Types
// ============================================================================

/**
 * Prep result for StandardInitNode.
 * Contains hooks and lifecycle needed for initialization.
 */
interface InitNodePrepResult<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
> {
  hooks: Hooks;
  lifecycle: Lifecycle;
}

/** Helper type to extract prep result from AgentRunShared */
type PrepResultOf<Shared extends AgentRunShared<any, any, any, any>> =
  InitNodePrepResult<Shared['lifecycle'], Shared['hooks']>;

// ============================================================================
// StandardInitNode
// ============================================================================

/**
 * Standard init node with error handling and phase transitions.
 *
 * PocketFlow pattern:
 * - prep(): Extract hooks and lifecycle from shared
 * - exec(): Run initialization sequence (errors throw naturally)
 * - execFallback(): Convert errors to result type
 * - post(): Transition phase on success, finalize on error
 *
 * Extension point (override in subclass):
 * - beforeStart(): Run operations before hooks.start()
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
 *   protected beforeStart(prepRes: PrepResultOf<MyShared>): void {
 *     prepRes.hooks.resetPromptBuilder();
 *   }
 * }
 * ```
 */
export class StandardInitNode<
  Shared extends AgentRunShared<any, any, any, any>,
> extends Node<Shared> {
  /**
   * @param nextPhase Phase to transition to on successful initialization
   */
  constructor(protected readonly nextPhase: Shared['lifecycle']['phase']) {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: Shared): Promise<PrepResultOf<Shared>> {
    return { hooks: shared.hooks, lifecycle: shared.lifecycle };
  }

  /**
   * Override for pre-start operations (e.g., reset prompt builder).
   * Called before hooks.start().
   */
  protected beforeStart(_prepRes: PrepResultOf<Shared>): void {
    // Default: no-op
  }

  async exec(prepRes: PrepResultOf<Shared>): Promise<{ kind: 'success' }> {
    prepRes.lifecycle.begin('init');

    // Run optional pre-start hook
    this.beforeStart(prepRes);

    // Let errors throw - Node._exec catches them and calls execFallback
    const runStage = await prepRes.hooks.start();
    await prepRes.hooks.init(runStage);
    await prepRes.hooks.initializeClient();

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
    if (execRes.kind === 'error') {
      shared.lifecycle.fail(execRes.error);
      return FlowTransition.FINALIZE;
    }
    shared.lifecycle.begin(this.nextPhase);
    return undefined; // Follow next() to the next node
  }
}
