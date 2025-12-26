/**
 * Service interfaces for reflection flow.
 *
 * Following the pattern from CycleServices.ts:
 * - Services are injected via PocketFlow's `_params` mechanism
 * - `_params.services` contains immutable dependencies
 * - `shared` contains mutable runtime state only
 */

import type { IModelHandler } from '@agent/modelHandlers';
import type { IOutputHandler } from '@agent/output';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentLogger } from '@logger/AgentLogger';
import type { PromptBuilder } from '@utils/prompt';
import type { AgentFileLocation, TaskRunFileService } from '@utils/files';
import type { LatexMediaManager } from '@latex';

/**
 * Services provided by BaseReflectionAgent for flow nodes.
 *
 * These are immutable dependencies that nodes use to perform their work.
 * The agent becomes a "service provider" - it holds these but doesn't
 * execute logic. Nodes do the work using these services.
 */
export interface ReflectionServices<C = unknown> {
  /** Model handler for API calls and message formatting */
  readonly modelHandler: IModelHandler<any, any, any, any, C>;

  /** Output handler for file processing and artifacts */
  readonly outputHandler: IOutputHandler;

  /** LaTeX media manager for figure/TikZ/PDF extraction */
  readonly latexMediaManager: LatexMediaManager;

  /** Prompt builder for constructing messages */
  readonly promptBuilder: PromptBuilder;

  /** File service for location resolution */
  readonly fileService: TaskRunFileService;

  /** Logger for debugging and progress */
  readonly logger: AgentLogger;

  /** Agent configuration (input files, model, etc.) */
  readonly config: AgentConfig;

  /** Agent workflow settings (rounds, temperature, etc.) */
  readonly setting: AgentWorkflowSetting;

  /** Agent prompt templates */
  readonly prompt: AgentPrompt;

  /** Execution context (IDs, storage key, etc.) */
  readonly context: AgentExecutionContext;

  /** User variable channels for template rendering */
  readonly userVarChannels: UserVariableChannels;

  /** Check if user requested interruption */
  readonly checkInterruption: () => Promise<boolean> | boolean;

  /** Set abort controller for cancellation */
  readonly setAbortController: (ctrl: AbortController | null) => void;

  /** Get the API client instance */
  readonly getClient: () => C;

  // =========================================================================
  // Agent method delegates
  // These delegate to agent methods to preserve polymorphism (subclass overrides)
  // =========================================================================

  /**
   * Get output file location for a round.
   * Delegates to agent.getOutputFileLocation() to respect subclass overrides.
   * Handles scratchpad mode, editedFile, and custom naming logic.
   */
  readonly getOutputFileLocation: (round: number) => AgentFileLocation;

  /**
   * Check if XML structure should be ensured before processing.
   * Delegates to agent.shouldEnsureXmlStructure() for polymorphic behavior.
   * - DirectAgent: returns useScratchpad
   * - CoTAgent: returns true
   * - Default: returns false
   */
  readonly shouldEnsureXmlStructure: () => boolean;
}

/**
 * Params type for reflection flow nodes.
 * Used with BaseNode's `_params` mechanism.
 */
export interface ReflectionFlowParams<C = unknown> {
  [key: string]: unknown;
  services: ReflectionServices<C>;
}
