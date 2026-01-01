/**
 * Service interfaces for reflection flow.
 *
 * Following the PocketFlow pattern:
 * - Services are injected via flow.setServices()
 * - Nodes access services via this.services
 * - shared contains mutable runtime state only (natively serializable)
 *
 * ReflectionServices extends BaseFlowContextInit directly with reflection-specific
 * dependencies (output handler, prompt builder, LaTeX media, etc.)
 */

import type { IOutputHandler } from '@agent/output';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import type { AgentLogStage, AgentLogger } from '@logger/AgentLogger';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { PromptBuilder } from '@utils/prompt';
import type { AgentFileLocation, TaskRunFileService } from '@utils/files';
import type { LatexMediaManager } from '@latex';

/**
 * Services for reflection flow nodes.
 *
 * Extends BaseFlowContextInit directly with reflection-specific dependencies:
 * - outputHandler: File processing and artifacts
 * - latexMediaManager: Figure/TikZ/PDF extraction
 * - promptBuilder: Message construction
 * - fileService: Location resolution
 * - runStage: Parent logging stage for round stages (runtime-only)
 * - Configuration-driven behavior delegates
 */
export interface ReflectionServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Logger for debugging and progress */
  readonly logger: AgentLogger;

  /** Execution context (IDs, storage key, etc.) */
  readonly context: AgentExecutionContext;
  /** Narrow setting to workflow-specific type */
  readonly setting: AgentWorkflowSetting;
  /** Output handler for file processing and artifacts */
  readonly outputHandler: IOutputHandler;

  /** LaTeX media manager for figure/TikZ/PDF extraction */
  readonly latexMediaManager: LatexMediaManager;

  /** Prompt builder for constructing messages */
  readonly promptBuilder: PromptBuilder;

  /** File service for location resolution */
  readonly fileService: TaskRunFileService;

  /**
   * Parent logging stage for round stages (r0, r1, r2...).
   * Runtime-only - NOT persisted (services are never serialized).
   *
   * Note: Individual round stages (r0, r1, r2...) are managed by
   * RoundPersistedFlow, not by services. This keeps round lifecycle
   * as a flow-level concern, invisible to individual nodes.
   */
  readonly runStage: AgentLogStage;

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
   * Based on xmlStructureMode config: 'never', 'scratchpadOnly', or 'always'.
   */
  readonly shouldEnsureXmlStructure: () => boolean;

  /**
   * Get usage recorder callback for tracking round statistics.
   * Returns a callback that will be invoked when a round finalizes.
   */
  readonly getUsageRecorder: () => RoundFinalizedCallback;
}

/**
 * Partial services type for buildReflectionServices output.
 * Excludes runStage since it's set by runReflectionFlow after creation.
 */
export type ReflectionServicesPartial<C = unknown> = Omit<
  ReflectionServices<C>,
  'runStage'
>;

/**
 * Flow params type for reflection flows.
 * Alias for base FlowParams - reserved for future use.
 */
export type { FlowParams as ReflectionFlowParams } from '../common';
