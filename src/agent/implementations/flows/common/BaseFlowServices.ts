/**
 * Base service interfaces and shared types for all flow types.
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

/** Node retry configuration: no retries (single attempt). */
export const NODE_NO_RETRY = 1;

/** Node wait configuration: no wait between retries. */
export const NODE_NO_WAIT = 0;

// ============================================================================
// Result Types
// ============================================================================

/** Generic result type for exec methods that return a value. */
export type NodeExecResult<T> =
  | { kind: 'success'; result: T }
  | { kind: 'error'; error: unknown };

// ============================================================================
// Service Interfaces
// ============================================================================

import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

// ============================================================================
// Core Agent Context
// ============================================================================

/**
 * Core agent context shared by all agent operations.
 *
 * This is the foundation that both resolution output (ResolvedAgentBase)
 * and flow inputs (BaseFlowContextInit) build upon. Defined once to
 * eliminate duplication.
 */
export interface AgentCore<C = unknown> {
  /** Model handler for API calls and message formatting */
  modelHandler: IModelHandler<any, any, any, any, C>;

  /** Agent configuration (input files, model, etc.) */
  config: AgentConfig;

  /** Agent settings (AgentWorkflowSetting or AgentToolUseSetting) */
  setting: AgentSetting;

  /** Agent prompt templates */
  prompt: AgentPrompt;

  /** Logger for operations */
  logger: AgentLogger;

  /** Stream/tab identifier for UI grouping */
  streamId: StreamTabId;

  /** Execution identifier */
  executionId: ExecutionId;

  /** User variable channels for template rendering */
  userVarChannels: UserVariableChannels;
}

// ============================================================================
// Flow Context Initialization
// ============================================================================

/**
 * Base initialization config shared by all flow contexts.
 *
 * Extends AgentCore with interrupt handling and usage recording.
 * Flow-specific contexts extend this with additional fields:
 * - ToolUseFlowContextInit adds: toolRegistry, resumeSnapshot
 * - RunReflectionFlowInput adds: storageKey, parentStage
 */
export interface BaseFlowContextInit<C = unknown> extends AgentCore<C> {
  /** Check if user requested interruption (synchronous) */
  checkInterruption: () => boolean;

  /** Set abort controller for cancellation */
  setAbortController: (ctrl: AbortController | null) => void;

  /** Callback invoked when interrupt() is called on the flow context */
  onInterrupt?: () => void;

  /** Usage recorder callback. If not provided, usage is not tracked. */
  getUsageRecorder?: () => RoundFinalizedCallback;
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
