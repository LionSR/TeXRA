/**
 * Service interfaces for reflection flow.
 *
 * Following the PocketFlow pattern:
 * - Services are injected via flow.setServices()
 * - Nodes access services via this.services
 * - shared contains mutable runtime state only
 *
 * ReflectionServices extends BaseFlowServices with reflection-specific
 * dependencies (output handler, prompt builder, LaTeX media, etc.)
 */

import type { IOutputHandler } from '@agent/output';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { BaseFlowServices } from '@agent/implementations/flows/common';
import type { PromptBuilder } from '@utils/prompt';
import type { AgentFileLocation, TaskRunFileService } from '@utils/files';
import type { LatexMediaManager } from '@latex';

/**
 * Services provided by BaseReflectionAgent for flow nodes.
 *
 * Extends BaseFlowServices with reflection-specific dependencies:
 * - outputHandler: File processing and artifacts
 * - latexMediaManager: Figure/TikZ/PDF extraction
 * - promptBuilder: Message construction
 * - fileService: Location resolution
 * - Agent method delegates for polymorphism
 *
 * The agent becomes a "service provider" - it holds these but doesn't
 * execute logic. Nodes do the work using these services.
 */
export interface ReflectionServices<C = unknown> extends BaseFlowServices<C> {
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
 * Flow params type for reflection flows.
 * Alias for base FlowParams - reserved for future use.
 */
export type { FlowParams as ReflectionFlowParams } from '../common';
