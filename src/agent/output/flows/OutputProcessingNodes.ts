/**
 * Output processing nodes following pocketflow architecture.
 *
 * This module provides a thin orchestration layer over OutputHandler,
 * following pocketflow's prep -> exec -> post pattern while delegating
 * the actual processing to the battle-tested OutputHandler implementation.
 *
 * Single source of truth: OutputHandler contains all processing logic.
 */

// Local imports - core flow primitives
import { Node } from '@agent/node';
import type { OutputFileInfo, FileLocation } from '@agent/output/types';
import type { IOutputHandler } from '@agent/output/IOutputHandler';
import type { AgentLogStage } from '@logger/AgentLogger';

// Local imports - types
import {
  OutputProcessingAction,
  type OutputProcessingActionType,
} from './OutputProcessingTypes';
import type { OutputProcessingShared } from './OutputProcessingTypes';

// ============================================================================
// SERVICE PARAMS - Injected dependencies for nodes
// ============================================================================

/**
 * Services required by output processing nodes.
 * OutputHandler is the single source of truth for processing logic.
 */
export interface OutputProcessingServices {
  /** OutputHandler instance - contains all processing logic */
  outputHandler: IOutputHandler;
  /** Callback to run XML validation before processing */
  ensureXmlStructure: (
    outputLocation: FileLocation,
    documentTag: string,
  ) => Promise<void>;
}

/**
 * Params interface for output processing nodes.
 * Must satisfy NonIterableObject constraint from pocketflow.
 */
export interface OutputProcessingParams {
  services: OutputProcessingServices;
  // Index signature required by NonIterableObject constraint
  [key: string]: unknown;
}

// ============================================================================
// PROCESS OUTPUT NODE - Delegates to OutputHandler
// ============================================================================

interface ProcessOutputPrep {
  outputLocation: FileLocation;
  currRound: number;
  shouldValidateXml: boolean;
  documentTag: string;
  stage?: AgentLogStage;
}

interface ProcessOutputExec {
  success: boolean;
  error?: Error;
}

/**
 * Processes output by delegating to OutputHandler.
 *
 * This node follows pocketflow pattern but delegates all actual processing
 * to OutputHandler.processOutputFiles(), keeping a single source of truth.
 */
export class ProcessOutputNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<ProcessOutputPrep> {
    const { input } = shared;
    return {
      outputLocation: input.outputLocation,
      currRound: input.currRound,
      shouldValidateXml: input.shouldValidateXml,
      documentTag: input.documentTag,
      stage: input.parentStage,
    };
  }

  async exec(prepRes: ProcessOutputPrep): Promise<ProcessOutputExec> {
    const { services } = this._params;

    try {
      // Step 1: XML validation (if needed)
      if (prepRes.shouldValidateXml) {
        await services.ensureXmlStructure(
          prepRes.outputLocation,
          prepRes.documentTag,
        );
      }

      // Step 2: Delegate all processing to OutputHandler (single source of truth)
      await services.outputHandler.processOutputFiles(
        prepRes.outputLocation,
        prepRes.currRound,
        prepRes.stage,
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async post(
    shared: OutputProcessingShared,
    prepRes: ProcessOutputPrep,
    execRes: ProcessOutputExec,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    if (!execRes.success) {
      shared.state.error = execRes.error ?? new Error('Processing failed');
      shared.state.shouldContinue = false;
      return OutputProcessingAction.ERROR;
    }

    // Get processed files from OutputHandler
    const files = services.outputHandler.ensureRound(prepRes.currRound);
    shared.state.processedFiles = files;
    shared.state.shouldContinue = false;

    return OutputProcessingAction.COMPLETE;
  }
}

// ============================================================================
// RE-EXPORTS for backward compatibility
// ============================================================================

// These are no longer separate nodes - all processing is done in ProcessOutputNode
// Keeping exports for any external code that might reference them
export {
  ProcessOutputNode as PrepareOutputNode,
  ProcessOutputNode as XmlValidationNode,
  ProcessOutputNode as ProcessFilesNode,
  ProcessOutputNode as IndentFilesNode,
  ProcessOutputNode as ReplaceInputCommandsNode,
  ProcessOutputNode as FinalizeOutputNode,
};
