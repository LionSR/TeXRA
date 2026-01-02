/**
 * TranslatingFlow - Enables native flow nesting with type translation.
 *
 * ## Problem
 *
 * PocketFlow's `Flow extends BaseNode` allows flows to be used as nodes.
 * However, when an inner flow has a different shared type than the outer flow,
 * the inner nodes would receive the wrong type.
 *
 * ## Solution
 *
 * TranslatingFlow overrides `_run()` to:
 * 1. Create a translation context from outer shared (via `prepContext()`)
 * 2. Create inner flow with inner shared type (via `createInnerFlow()`)
 * 3. Run inner flow with inner shared (type substitution)
 * 4. Apply results back to outer shared (via `applyResults()`)
 *
 * ## Usage
 *
 * ```typescript
 * class MyCycleFlow extends TranslatingFlow<OuterShared, InnerShared, ...> {
 *   async prepContext(outer) {
 *     // Extract data from outer shared
 *     return { messages: outer.context.messages, ... };
 *   }
 *
 *   createInnerFlow(context) {
 *     const flow = createMyInnerFlow();
 *     flow.setServices(this.buildServices(context));
 *     return {
 *       flow,
 *       shared: { state: { messages: context.messages }, retryState: createRetryState() }
 *     };
 *   }
 *
 *   async applyResults(outer, inner, context) {
 *     outer.results = inner.state.results;
 *     return FlowTransition.DEFAULT;
 *   }
 * }
 * ```
 *
 * This IS a Flow (extends Flow), so it can be wired into any Flow's node graph.
 * When reached, its _run() handles the type translation automatically.
 */

import { BaseNode, Flow, type NonIterableObject } from '@agent/node';

/**
 * Result of inner flow creation.
 */
export interface InnerFlowContext<InnerShared> {
  /** The inner flow to run */
  flow: Flow<InnerShared, NonIterableObject, unknown>;
  /** The inner shared state */
  shared: InnerShared;
}

/**
 * Base class for flows that translate between outer and inner shared types.
 *
 * Extends Flow so it can be used as a node in other flows (native nesting).
 * Overrides _run() to substitute shared types for inner flow execution.
 *
 * @template OuterShared - The outer flow's shared type
 * @template InnerShared - The inner flow's shared type
 * @template Context - The translation context type (returned by prepContext)
 * @template OuterParams - The outer flow's params type
 * @template OuterServices - The outer flow's services type
 */
export abstract class TranslatingFlow<
  OuterShared,
  InnerShared,
  Context,
  OuterParams extends NonIterableObject = NonIterableObject,
  OuterServices = unknown,
> extends Flow<OuterShared, OuterParams, OuterServices> {
  /**
   * Stored inner shared for result access.
   * Set during _run(), available in applyResults().
   */
  protected innerShared: InnerShared | null = null;

  constructor() {
    // Pass a dummy start node - we override _run() entirely
    super(new DummyNode());
  }

  /**
   * Prepare translation context from outer shared.
   *
   * This is like a wrapper node's prep() - extracts what's needed
   * to create the inner flow and shared state.
   *
   * @param outer - The outer flow's shared state
   * @returns Translation context, or null to skip inner flow execution
   */
  abstract prepContext(outer: OuterShared): Promise<Context | null>;

  /**
   * Create the inner flow and shared state.
   *
   * Called after prepContext() returns a non-null context.
   * The returned flow will have services set via setServices().
   *
   * @param context - The translation context from prepContext()
   * @returns Inner flow and shared state
   */
  abstract createInnerFlow(context: Context): InnerFlowContext<InnerShared>;

  /**
   * Apply inner flow results back to outer shared.
   *
   * This is like a wrapper node's post() - translates results
   * from inner shared back to outer shared.
   *
   * @param outer - The outer flow's shared state (to update)
   * @param inner - The inner flow's shared state after execution (null if skipped)
   * @param context - The translation context from prepContext() (null if skipped)
   * @returns Flow transition action
   */
  abstract applyResults(
    outer: OuterShared,
    inner: InnerShared | null,
    context: Context | null,
  ): Promise<string | undefined>;

  /**
   * Override _run() to substitute shared types.
   *
   * This is the core of native flow nesting with type translation:
   * 1. Prepare context from outer shared
   * 2. Create inner flow with inner shared type
   * 3. Run inner flow (type substitution happens here)
   * 4. Apply results back to outer shared
   */
  async _run(outer: OuterShared): Promise<string | undefined> {
    // Phase 1: Prepare translation context
    const context = await this.prepContext(outer);

    if (context === null) {
      // Skip inner flow execution
      return await this.applyResults(outer, null, null);
    }

    // Phase 2: Create inner flow with inner shared type
    const { flow, shared } = this.createInnerFlow(context);

    // Phase 3: Run inner flow with inner shared (type substitution!)
    // Services are already set in createInnerFlow()
    await flow.run(shared);

    // Store for potential access in subclasses
    this.innerShared = shared;

    // Phase 4: Apply results back to outer shared
    return await this.applyResults(outer, shared, context);
  }

  // Override Flow methods that shouldn't be used directly
  async prep(_shared: OuterShared): Promise<unknown> {
    // Not used - prepContext() is called in _run()
    return undefined;
  }

  async post(
    _shared: OuterShared,
    _prepRes: unknown,
    _execRes: unknown,
  ): Promise<string | undefined> {
    // Not used - applyResults() is called in _run()
    return undefined;
  }
}

/**
 * Dummy node used as Flow's start node.
 * Never actually executed - TranslatingFlow overrides _run() entirely.
 */
class DummyNode extends BaseNode<unknown, NonIterableObject, unknown> {
  async _run(_shared: unknown): Promise<string | undefined> {
    throw new Error('DummyNode should never be executed');
  }
}
