/**
 * Agent run flow factory - creates the standard init → work → finalize flow structure.
 *
 * Uses PocketFlow's native wiring pattern:
 * - next() for linear (happy path) flow
 * - on() only for branches (errors → finalize)
 * - Nodes return undefined for happy path, explicit action for branches
 */

// Core imports
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimum shared state required for init node operation.
 */
export interface AgentInitShared<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
}

/**
 * Configuration for the init node.
 */
export interface AgentInitNodeConfig<Shared extends AgentInitShared<any, any>> {
  /** Phase to set when init begins */
  phase: Shared['lifecycle']['phase'];
  /** Called before client initialization (for lifecycle setup) */
  beforeInitialize?(shared: Shared): void | Promise<void>;
  /** Called on success (for lifecycle transitions). Return value ignored - follows next() */
  onSuccess?(shared: Shared): void | Promise<void>;
}

// ============================================================================
// Init Node (internal implementation)
// ============================================================================

/** Result type for init node exec - uses 'kind' discriminant for consistency. */
type InitExecResult =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown };

class AgentInitNode<
  Shared extends AgentInitShared<any, any>,
> extends BaseNode<Shared> {
  constructor(private readonly config: AgentInitNodeConfig<Shared>) {
    super();
  }

  async prep(shared: Shared) {
    return { hooks: shared.hooks, shared, lifecycle: shared.lifecycle };
  }

  async exec(prepRes: {
    hooks: Shared['hooks'];
    shared: Shared;
    lifecycle: Shared['lifecycle'];
  }): Promise<InitExecResult> {
    prepRes.lifecycle.begin(this.config.phase);

    try {
      const runStage = await prepRes.hooks.start();
      await prepRes.hooks.init(runStage);
      if (this.config.beforeInitialize) {
        await this.config.beforeInitialize(prepRes.shared);
      }
      await prepRes.hooks.initializeClient();
      return { kind: 'success' };
    } catch (error) {
      return { kind: 'error', error };
    }
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
    // Success: call callback then follow next()
    if (this.config.onSuccess) {
      await this.config.onSuccess(shared);
    }
    return undefined; // Follow next() chain
  }
}

// ============================================================================
// Flow Factory
// ============================================================================

interface CreateAgentRunFlowOptions<Shared extends AgentInitShared<any, any>> {
  /** Configuration for the init node */
  init: AgentInitNodeConfig<Shared>;
  /** First node after init (init.next() points here) */
  start: BaseNode<Shared>;
  /** Finalize node (init error → finalize) */
  finalize: BaseNode<Shared>;
}

/**
 * Creates an agent run flow with standard init → work → finalize structure.
 *
 * Uses PocketFlow's native wiring:
 * - init.next(start) for happy path
 * - init.on(FINALIZE, finalize) for error path
 *
 * Callers wire their own nodes using next()/on() before calling this.
 *
 * @example
 * ```typescript
 * // Wire nodes using native PocketFlow API
 * prepNode.next(cycleNode);
 * cycleNode.next(waitNode);
 * waitNode.on(FlowTransition.CONTINUE, cycleNode);
 * waitNode.on(FlowTransition.FINALIZE, finalizeNode);
 *
 * // Create flow
 * const flow = createAgentRunFlow<MyShared>({
 *   init: { phase: 'init', onSuccess: (s) => s.lifecycle.begin('work') },
 *   start: prepNode,
 *   finalize: finalizeNode,
 * });
 * ```
 */
export function createAgentRunFlow<Shared extends AgentInitShared<any, any>>({
  init,
  start,
  finalize,
}: CreateAgentRunFlowOptions<Shared>): Flow<Shared> {
  const initNode = new AgentInitNode<Shared>(init);

  // Wire using native PocketFlow API
  initNode.next(start); // Happy path: init → start
  initNode.on(FlowTransition.FINALIZE, finalize); // Error path: init → finalize

  return new Flow<Shared>(initNode);
}
