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
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Base services shared by all agent flows.
 *
 * These are the core immutable dependencies that every flow needs:
 * - Model interaction (modelHandler, getClient)
 * - Configuration (config, setting, prompt)
 * - Runtime context (context, logger, userVarChannels)
 * - Control (checkInterruption, setAbortController)
 *
 * Flow-specific interfaces extend this with additional services:
 * - ReflectionServices: outputHandler, promptBuilder, latexMediaManager, etc.
 * - ToolUseServices: toolRegistry, session, cycle operations, etc.
 */
export interface BaseFlowServices<C = unknown> {
  /** Model handler for API calls and message formatting */
  readonly modelHandler: IModelHandler<any, any, any, any, C>;

  /** Logger for debugging and progress */
  readonly logger: AgentLogger;

  /** Agent configuration (input files, model, etc.) */
  readonly config: AgentConfig;

  /** Agent settings (AgentWorkflowSetting or AgentToolUseSetting) */
  readonly setting: AgentSetting;

  /** Agent prompt templates */
  readonly prompt: AgentPrompt;

  /** Execution context (IDs, storage key, etc.) */
  readonly context: AgentExecutionContext;

  /** User variable channels for template rendering */
  readonly userVarChannels: UserVariableChannels;

  /** Check if user requested interruption (synchronous) */
  readonly checkInterruption: () => boolean;

  /** Set abort controller for cancellation */
  readonly setAbortController: (ctrl: AbortController | null) => void;

  /** Get the API client instance */
  readonly getClient: () => C;
}

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
 * Extracts the common service properties that both ReflectionFlowContext
 * and ToolUseFlowContext need. Flow contexts can spread this result and
 * add their specialized services on top.
 */
export function buildBaseFlowServices<C>(
  init: BaseFlowContextInit<C>,
): BaseFlowServices<C> {
  return {
    modelHandler: init.modelHandler,
    logger: init.executionContext.logger,
    config: init.config,
    setting: init.setting,
    prompt: init.prompt,
    context: init.executionContext,
    userVarChannels: init.userVarChannels,
    checkInterruption: init.checkInterruption,
    setAbortController: init.setAbortController,
    getClient: init.getClient,
  };
}
