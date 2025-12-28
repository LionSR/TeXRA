/**
 * ReflectionFlowContext - Unified execution context for reflection flows.
 *
 * This module consolidates all services and configuration needed by the flow,
 * replacing the previous pattern where agents provided services via callbacks.
 *
 * ## Architecture: Flow-First Design
 *
 * Instead of:
 *   Agent creates services → passes to flow → flow calls back to agent
 *
 * We now have:
 *   Context factory creates everything → flow owns all services
 *
 * ## Key Changes:
 *
 * 1. **Services created here, not in agent** - outputHandler, promptBuilder,
 *    latexMediaManager, fileService are all created during context setup.
 *
 * 2. **Strategies instead of callbacks** - Polymorphic behavior (like
 *    shouldEnsureXmlStructure) is captured via strategy objects at creation
 *    time, not via callbacks to agent methods.
 *
 * 3. **No agent reference** - The flow doesn't need to know about the agent.
 *    All necessary state and behavior is in the context.
 *
 * ## Usage:
 *
 * ```typescript
 * // In agent.run() or factory function:
 * const context = createReflectionFlowContext({
 *   modelHandler,
 *   config: agentConfig,
 *   setting: agentSetting,
 *   prompt: agentPrompt,
 *   executionContext,
 *   userVarChannels,
 *   strategies: {
 *     getOutputFileLocation: (round) => ...,
 *     shouldEnsureXmlStructure: () => ...,
 *   },
 * });
 *
 * const flow = createReflectionFlow();
 * flow.setServices(context.services);
 * await flow.run(shared);
 * ```
 */

import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentFileLocation, TaskRunFileService } from '@utils/files';
import type { LatexMediaManager } from '@latex';
import type { IOutputHandler } from '@agent/output';
import type { PromptBuilder } from '@utils/prompt';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Strategy Interfaces
// ============================================================================

/**
 * Strategies for polymorphic behavior in reflection flows.
 *
 * These replace direct callbacks to agent methods. By capturing strategies
 * at context creation time, we:
 * 1. Remove the flow's dependency on agent instance
 * 2. Make polymorphism explicit and testable
 * 3. Allow alternative implementations without subclassing
 */
export interface ReflectionFlowStrategies {
  /**
   * Strategy for determining output file location.
   *
   * Different agent types have different naming conventions:
   * - DirectAgent: uses agentConfig.inputFile
   * - MergeAgent: extracts filename from response
   * - CoTAgent: adds round suffix
   */
  getOutputFileLocation: (round: number) => AgentFileLocation;

  /**
   * Strategy for XML structure enforcement.
   *
   * Different agent types have different requirements:
   * - DirectAgent: only when useScratchpad is true
   * - CoTAgent: always true
   * - Default: false
   */
  shouldEnsureXmlStructure: () => boolean;

  /**
   * Strategy for usage recording.
   *
   * Returns a callback invoked when each round finalizes.
   * This tracks token usage, response times, etc.
   */
  getUsageRecorder: () => AgentRoundFinalizedCallback;
}

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating a ReflectionFlowContext.
 *
 * All required dependencies are provided here. The context factory
 * creates derived services (outputHandler, promptBuilder, etc.) from these.
 */
export interface ReflectionFlowContextInit<C = unknown> {
  // Core dependencies (provided by caller)
  modelHandler: IModelHandler<any, any, any, any, C>;
  config: AgentConfig;
  setting: AgentWorkflowSetting;
  prompt: AgentPrompt;
  executionContext: AgentExecutionContext;
  userVarChannels: UserVariableChannels;

  // Pre-built services (optional - context can create if not provided)
  outputHandler?: IOutputHandler;
  promptBuilder?: PromptBuilder;
  latexMediaManager?: LatexMediaManager;
  fileService?: TaskRunFileService;

  // Control callbacks (must be from agent for interruption/abort)
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  getClient: () => C;

  // Strategies for polymorphic behavior
  strategies: ReflectionFlowStrategies;
}

// ============================================================================
// Context Class
// ============================================================================

/**
 * Unified execution context for reflection flows.
 *
 * This class holds all services and configuration needed by flow nodes.
 * It implements the ReflectionServices interface for compatibility with
 * existing node code.
 */
export class ReflectionFlowContext<C = unknown> {
  private readonly init: ReflectionFlowContextInit<C>;
  private _services: ReflectionServices<C> | null = null;

  constructor(init: ReflectionFlowContextInit<C>) {
    this.init = init;
  }

  /**
   * Get services for flow injection.
   *
   * This returns the same interface as the old agent.services getter,
   * allowing existing nodes to work unchanged.
   */
  get services(): ReflectionServices<C> {
    if (this._services) {
      return this._services;
    }

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
      strategies,
    } = this.init;

    // Use provided services or throw if not available
    // (In full implementation, context would create these)
    const outputHandler = this.init.outputHandler;
    const promptBuilder = this.init.promptBuilder;
    const latexMediaManager = this.init.latexMediaManager;
    const fileService = this.init.fileService;

    if (!outputHandler || !promptBuilder || !latexMediaManager || !fileService) {
      throw new Error(
        'ReflectionFlowContext: Required services not provided. ' +
          'Provide outputHandler, promptBuilder, latexMediaManager, and fileService.',
      );
    }

    this._services = {
      // Base services
      modelHandler,
      logger: executionContext.logger,
      config,
      setting,
      prompt,
      context: executionContext,
      userVarChannels,
      checkInterruption,
      setAbortController,
      getClient,

      // Reflection-specific services
      outputHandler,
      latexMediaManager,
      promptBuilder,
      fileService,

      // Strategies (no callbacks to agent!)
      getOutputFileLocation: strategies.getOutputFileLocation,
      shouldEnsureXmlStructure: strategies.shouldEnsureXmlStructure,
      getUsageRecorder: strategies.getUsageRecorder,
    };

    return this._services;
  }

  // =========================================================================
  // Convenience accessors
  // =========================================================================

  get logger() {
    return this.init.executionContext.logger;
  }

  get executionId() {
    return this.init.executionContext.executionId;
  }

  get storageKey() {
    return this.init.executionContext.storageKey;
  }

  get config() {
    return this.init.config;
  }

  get setting() {
    return this.init.setting;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a ReflectionFlowContext with all services configured.
 *
 * This is the primary entry point for setting up flow execution.
 * Call this in agent.run() instead of building services inline.
 */
export function createReflectionFlowContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
): ReflectionFlowContext<C> {
  return new ReflectionFlowContext(init);
}
