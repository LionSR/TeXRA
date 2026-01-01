/**
 * Base service interfaces shared across all flow types.
 *
 * Following the PocketFlow pattern:
 * - Services are immutable dependencies injected via flow.setServices()
 * - Nodes access services via this.services
 * - shared contains only mutable state (memories)
 *
 * This base interface captures common services that all agent flows need.
 * Flow-specific services extend this interface.
 */

// ============================================================================
// Node Configuration Constants
// ============================================================================

/**
 * Node retry configuration: no retries (single attempt).
 * Most flow nodes don't retry - errors bubble up to agent.run() for handling.
 */
export const NODE_NO_RETRY = 1;

/**
 * Node wait configuration: no wait between retries.
 * When retries are disabled, this has no effect.
 */
export const NODE_NO_WAIT = 0;

// ============================================================================
// Service Interfaces
// ============================================================================

import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';
import type { AgentLogger } from '@logger/AgentLogger';

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Base initialization config shared by all flow contexts.
 *
 * Flow-specific contexts extend this with additional fields:
 * - ToolUseFlowContextInit adds: streamTabId, toolRegistry, resumeSnapshot
 * - ReflectionFlowContextInit adds: getUsageRecorder (required)
 */
export interface BaseFlowContextInit<C = unknown> {
  /** Model handler for API calls and message formatting */
  modelHandler: IModelHandler<any, any, any, any, C>;

  /** Agent configuration (input files, model, etc.) */
  config: AgentConfig;

  /** Agent settings (AgentWorkflowSetting or AgentToolUseSetting) */
  setting: AgentSetting;

  /** Agent prompt templates */
  prompt: AgentPrompt;

  /** Execution context (IDs, storage key, etc.) */
  executionContext: AgentExecutionContext;

  /** User variable channels for template rendering */
  userVarChannels: UserVariableChannels;

  /** Check if user requested interruption (synchronous) */
  checkInterruption: () => boolean;

  /** Set abort controller for cancellation */
  setAbortController: (ctrl: AbortController | null) => void;

  /** Get the API client instance */
  getClient: () => C;

  /** Callback invoked when interrupt() is called on the flow context */
  onInterrupt?: () => void;
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Convenience accessors added to services.
 *
 * These are convenience aliases that simplify access patterns:
 * - logger: Direct access to executionContext.logger
 * - context: Alias for executionContext (used by cycle options)
 *
 * Child service interfaces (ReflectionServices, ToolUseServices) extend
 * BaseFlowContextInit and include these accessors directly.
 *
 * @deprecated Use BaseFlowContextInit directly. Child services now define
 * logger and context fields inline. This type is kept for backward compatibility.
 */
export type BaseFlowServices<C = unknown> = BaseFlowContextInit<C> & {
  /** Logger for debugging and progress (convenience accessor) */
  readonly logger: AgentLogger;
  /** Alias for executionContext (used by AgentCycleOptions) */
  readonly context: AgentExecutionContext;
};

/**
 * Base flow params type.
 *
 * Params are runtime values passed to flows via setParams().
 * Currently empty but reserved for future use (e.g., per-run configuration).
 * Flow-specific interfaces can extend or alias this type.
 */
export interface FlowParams {
  [key: string]: unknown;
}

// ============================================================================
// Service Factory
// ============================================================================

/**
 * Build base flow services from initialization config.
 *
 * Spreads init and adds convenience accessors (logger, context alias).
 */
export function buildBaseFlowServices<C>(
  init: BaseFlowContextInit<C>,
): BaseFlowServices<C> {
  return {
    ...init,
    logger: init.executionContext.logger,
    context: init.executionContext,
  };
}

// ============================================================================
// Cycle Options Builder
// ============================================================================

/**
 * Build AgentCycleBaseOptions from BaseFlowServices or BaseFlowContextInit.
 *
 * Eliminates manual field copying by mapping service fields to cycle option fields:
 * - setting -> agentSetting
 * - prompt -> agentPrompt
 * - userVarChannels.transient -> userVars
 * - executionContext -> context (via services.context if available)
 * - getClient() -> client
 *
 * This helper enables inheritance-based option building instead of manual field copying.
 *
 * ## Consolidation Note
 *
 * This function exists because service and cycle option interfaces use different
 * field names for the same concepts (e.g., `setting` vs `agentSetting`). Once field
 * names are unified across interfaces, this mapping function becomes unnecessary.
 * See docs/architecture/CONSOLIDATION_PROPOSAL.md Phase 5 for details.
 *
 * @param services - Flow services or initialization config
 * @returns Base cycle options ready for extension
 */
export function buildBaseCycleOptions<C>(
  services: BaseFlowServices<C> | BaseFlowContextInit<C>,
): AgentCycleBaseOptions<C> {
  return {
    modelHandler: services.modelHandler,
    agentSetting: services.setting,
    agentPrompt: services.prompt,
    userVars: services.userVarChannels.transient,
    logger:
      'logger' in services ? services.logger : services.executionContext.logger,
    context:
      'context' in services ? services.context : services.executionContext,
    client: services.getClient(),
    checkInterruption: services.checkInterruption,
    setAbortController: services.setAbortController,
  };
}
