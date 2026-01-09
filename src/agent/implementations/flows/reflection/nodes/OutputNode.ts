/**
 * OutputNode - Handles output processing after response cycle.
 *
 * Processes output files, handles latexdiff, and finalizes round artifacts.
 * Non-critical operations can fail gracefully (logged as warnings).
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

  async prep(shared: ReflectionFlowShared): Promise<OutputPrepInput> {
    const { baseFiles, shouldEnsureXmlStructure } = this.services;
    const { currentRound, outputLocation, endTurn } = shared;

    if (!outputLocation) {
      throw new Error(
        'Output location not set - ResponseCycleNode must run first',
      );
    }

    return {
      currentRound,
      outputLocation,
      endTurn,
      baseFiles,
      ensureXmlStructure: shouldEnsureXmlStructure,
    };
  }

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

      if (ensureXmlStructure) {
        try {
          await outputHandler.ensureXmlStructure(
            outputLocation,
            setting.documentTag ?? 'document',
          );
        } catch (error) {
          logger.warn(`XML structure failed: ${toErrorMessage(error)}`);
        }
      }

      try {
        await outputHandler.processOutputFiles(outputLocation, currentRound);
      } catch (error) {
        logger.warn(`Output processing failed: ${toErrorMessage(error)}`);
      }

      if (outputHandler.hasRoundOutputs(currentRound)) {
        try {
          await this.handleLatexdiff(currentRound, baseFiles);
        } catch (error) {
          logger.warn(`Latexdiff failed: ${toErrorMessage(error)}`);
        }
      }
    }

    try {
      await outputHandler.finalizeRound(outputLocation, currentRound, {
        endTurn,
      });
    } catch (error) {
      logger.warn(`Round finalization failed: ${toErrorMessage(error)}`);
    }

    // Get round artifacts - this is critical, throw if it fails
    return await outputHandler.getRoundArtifacts(currentRound);
  }

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
