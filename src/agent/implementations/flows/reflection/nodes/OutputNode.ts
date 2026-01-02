/**
 * OutputNode - Handles output processing after response cycle.
 *
 * Responsibilities:
 * - Ensure XML structure (if applicable)
 * - Process output files
 * - Handle latexdiff operations
 * - Finalize round and get artifacts
 *
 * All operations can fail gracefully - latexdiff failures
 * shouldn't stop the round from completing.
 *
 * PocketFlow pattern:
 * - prep(): Extract output location and round info
 * - exec(): Process output files and latexdiff
 * - post(): Store round output in shared
 *
 * Serialization pattern (koala-code-reader):
 * - Accesses only natively serializable state fields
 * - Stores RoundOutput (plain JSON) to shared.roundOutputs
 * - No class instances or runtime dependencies in state
 *
 * Services accessed via native `this.services`:
 * - outputHandler, logger, setting, fileService
 */

import { Node } from '@agent/node';
import type { RoundOutput } from '@agent/output';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { toErrorMessage } from '@common/errors';
import type { AgentFileLocation, FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';

import { createBaseFileLocations } from '../helpers';
import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface OutputPrepInput {
  currentRound: number;
  outputLocation: AgentFileLocation;
  endTurn: boolean;
  baseFiles: FileLocation[]; // Can include external files
  ensureXmlStructure: boolean;
}

type OutputExecResult = RoundOutput;

// ============================================================================
// Node Implementation
// ============================================================================

export class OutputNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * Extract data needed for output processing.
   */
  async prep(shared: ReflectionFlowShared): Promise<OutputPrepInput> {
    const { config, fileService, setting } = this.services;
    const { currentRound, outputLocation, endTurn } = shared;

    if (!outputLocation) {
      throw new Error(
        'Output location not set - ResponseCycleNode must run first',
      );
    }

    // Base files for latexdiff - MUST be workspace locations
    const baseFiles = createBaseFileLocations(config);

    // Determine if we should ensure XML structure (based on xmlStructureMode config)
    const ensureXmlStructure = this.services.shouldEnsureXmlStructure;

    return {
      currentRound,
      outputLocation,
      endTurn,
      baseFiles,
      ensureXmlStructure,
    };
  }

  /**
   * Process output files and handle latexdiff.
   * Logs warnings for non-critical failures. Throws on critical failures.
   */
  async exec(prepRes: OutputPrepInput): Promise<OutputExecResult> {
    const { outputHandler, setting, logger } = this.services;
    const {
      currentRound,
      outputLocation,
      endTurn,
      baseFiles,
      ensureXmlStructure,
    } = prepRes;

    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      // Ensure XML structure if needed
      if (ensureXmlStructure) {
        try {
          await outputHandler.ensureXmlStructure(
            outputLocation,
            setting.documentTag ?? 'document',
          );
        } catch (error) {
          const msg = toErrorMessage(error);
          logger.warn(`XML structure failed: ${msg}`);
        }
      }

      // Process output files
      try {
        await outputHandler.processOutputFiles(outputLocation, currentRound);
      } catch (error) {
        const msg = toErrorMessage(error);
        logger.warn(`Output processing failed: ${msg}`);
      }

      // Handle latexdiff if we have outputs and base files
      if (outputHandler.hasRoundOutputs(currentRound)) {
        try {
          await this.handleLatexdiff(currentRound, baseFiles);
        } catch (error) {
          const msg = toErrorMessage(error);
          logger.warn(`Latexdiff failed: ${msg}`);
        }
      }
    }

    // Finalize round
    try {
      await outputHandler.finalizeRound(outputLocation, currentRound, {
        endTurn,
      });
    } catch (error) {
      const msg = toErrorMessage(error);
      logger.warn(`Round finalization failed: ${msg}`);
    }

    // Get round artifacts - this is critical, throw if it fails
    return await outputHandler.getRoundArtifacts(currentRound);
  }

  /**
   * Handle total failure - log warning and return empty output.
   */
  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<OutputExecResult> {
    this.services.logger.warn(`Output processing failed: ${error.message}`);
    return {
      round: prepRes.currentRound,
      rawOutput: null,
      outputs: [],
      xmlSummary: {
        tagContents: {},
        documents: [],
        singleOutputFile: null,
        sourceLocation: null,
      },
    };
  }

  /**
   * Store round output in shared.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: OutputPrepInput,
    execRes: OutputExecResult,
  ): Promise<string | undefined> {
    // Store round output
    shared.roundOutputs[shared.currentRound] = execRes;

    // Continue to RoundCompleteNode
    return FlowTransition.DEFAULT;
  }

  /**
   * Handle latexdiff operations.
   */
  private async handleLatexdiff(
    currentRound: number,
    baseFiles: FileLocation[],
  ): Promise<void> {
    const { outputHandler, logger } = this.services;

    // Check if any base files exist
    const existingBase = await Promise.all(
      baseFiles.map(async (f) => await flexibleFS.exists(f)),
    );

    if (!existingBase.some((e) => e)) {
      logger.debug('No base files found for latexdiff');
      return;
    }

    const mapping = outputHandler.getRoundMapping(currentRound);
    if (!mapping) {
      logger.debug('No round mapping found for latexdiff');
      return;
    }

    await outputHandler.diffManager.handleLatexdiffofOutput(
      currentRound,
      mapping,
    );
  }
}
