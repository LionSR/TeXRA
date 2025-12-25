/**
 * Agent run flow factory - creates the standard init → work → finalize flow structure.
 *
 * This module consolidates:
 * - Flow graph wiring (formerly buildRunFlow.ts)
 * - Init node implementation (formerly AgentInitNode.ts)
 * - Flow factory (createAgentRunFlow)
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
  phase: Shared['lifecycle']['phase'];
  beforeInitialize?(shared: Shared): void | Promise<void>;
  onSuccess(shared: Shared): string | Promise<string | undefined>;
  onFailure?(
    shared: Shared,
    error: unknown,
  ): string | Promise<string | undefined>;
  failureTransition?: string;
}

/**
 * Link between flow nodes.
 * When `to` is undefined, the link targets the finalize node.
 */
export interface FlowLink<Shared> {
  from: BaseNode<Shared>;
  on: string;
  to?: BaseNode<Shared>;
}

// ============================================================================
// Init Node (internal implementation)
// ============================================================================

/** Result type for init node exec - success ({}) or failure ({error}) */
type InitExecResult = { error?: unknown };

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
      return {};
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: Shared,
    _prepRes: unknown,
    execRes: InitExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      shared.lifecycle.fail(execRes.error);
      if (this.config.onFailure) {
        return this.config.onFailure(shared, execRes.error);
      }
      return this.config.failureTransition ?? FlowTransition.FINALIZE;
    }
    return this.config.onSuccess(shared);
  }
}

// ============================================================================
// Flow Factory
// ============================================================================

interface CreateAgentRunFlowOptions<Shared extends AgentInitShared<any, any>> {
  init: AgentInitNodeConfig<Shared>;
  finalize: BaseNode<Shared>;
  links(nodes: {
    init: AgentInitNode<Shared>;
    finalize: BaseNode<Shared>;
  }): FlowLink<Shared>[];
}

/**
 * Creates an agent run flow with standard init → work → finalize structure.
 *
 * The flow automatically wires:
 * - Init node with FINALIZE transition to finalize node
 * - All provided links (undefined `to` targets finalize)
 *
 * @example
 * ```typescript
 * const flow = createAgentRunFlow<MyShared>({
 *   init: { phase: 'init', onSuccess: () => 'execute' },
 *   finalize: finalizeNode,
 *   links: ({ init }) => [
 *     { from: init, on: 'execute', to: workNode },
 *     { from: workNode, on: 'finalize' }, // undefined to = finalize
 *   ],
 * });
 * ```
 */
export function createAgentRunFlow<Shared extends AgentInitShared<any, any>>({
  init,
  finalize,
  links,
}: CreateAgentRunFlowOptions<Shared>): Flow<Shared> {
  const initNode = new AgentInitNode<Shared>(init);
  const linkDefinitions = links({ init: initNode, finalize });

  // Wire the flow graph (formerly buildRunFlow)
  initNode.on(FlowTransition.FINALIZE, finalize);
  for (const link of linkDefinitions) {
    link.from.on(link.on, link.to ?? finalize);
  }

  return new Flow<Shared>(initNode);
}
