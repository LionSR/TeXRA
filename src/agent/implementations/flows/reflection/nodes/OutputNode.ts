/**
 * OutputNode - Handles output processing after response cycle.
 *
 * Processes output files, handles latexdiff, and finalizes round artifacts.
 * Non-critical operations can fail gracefully (logged as warnings).
 */

import { Node } from '@agent/node';
import type { RoundFileMapping } from '@agent/output/types';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { toErrorMessage } from '@common/errors';
import type { AgentFileLocation, FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';
import type { RoundOutput } from '@shared/schemas';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Prep result carries shared reference and validated output location.
 * Other fields are accessed directly from shared and services.
 */
interface OutputPrepInput {
  shared: ReflectionFlowShared;
  outputLocation: AgentFileLocation;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Execute an operation that can fail gracefully.
 * Logs warnings on failure but doesn't throw.
 */
async function tryOperation(
  label: string,
  operation: () => Promise<void>,
  logger: { warn: (msg: string) => void },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(`${label} failed: ${toErrorMessage(error)}`);
  }
}

// ============================================================================
// Node Implementation
// ============================================================================

export class OutputNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<OutputPrepInput> {
    if (!shared.outputLocation) {
      throw new Error(
        'Output location not set - ResponseCycleNode must run first',
      );
    }

    return {
      shared,
      outputLocation: shared.outputLocation,
    };
  }

  async exec(prepRes: OutputPrepInput): Promise<RoundOutput> {
    const { outputHandler, setting, logger, baseFiles, shouldEnsureXmlStructure } = this.services;
    const { shared, outputLocation } = prepRes;
    const { currentRound, endTurn } = shared;

    // Calculate mapping once for both latexdiff and finalization
    let mapping: RoundFileMapping | undefined;

    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      if (shouldEnsureXmlStructure) {
        await tryOperation(
          'XML structure',
          () =>
            outputHandler.ensureXmlStructure(
              outputLocation,
              setting.documentTag ?? 'document',
            ),
          logger,
        );
      }

      await tryOperation(
        'Output processing',
        () => outputHandler.processOutputFiles(outputLocation, currentRound),
        logger,
      );

      if (outputHandler.hasRoundOutputs(currentRound)) {
        mapping = outputHandler.getRoundMapping(currentRound);

        await tryOperation(
          'Latexdiff',
          () => this.handleLatexdiff(currentRound, baseFiles, mapping!),
          logger,
        );
      }
    }

    await tryOperation(
      'Round finalization',
      () =>
        outputHandler.finalizeRound(outputLocation, currentRound, {
          endTurn,
          mapping,
        }),
      logger,
    );

    // Get round artifacts - this is critical, throw if it fails
    return await outputHandler.getRoundArtifacts(currentRound);
  }

  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<RoundOutput> {
    this.services.logger.warn(`Output processing failed: ${error.message}`);
    return {
      round: prepRes.shared.currentRound,
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
    _shared: ReflectionFlowShared,
    prepRes: OutputPrepInput,
    execRes: RoundOutput,
  ): Promise<string | undefined> {
    // Store round output
    prepRes.shared.roundOutputs[prepRes.shared.currentRound] = execRes;

    // Continue to RoundCompleteNode
    return FlowTransition.DEFAULT;
  }

  private async handleLatexdiff(
    currentRound: number,
    baseFiles: FileLocation[],
    mapping: RoundFileMapping,
  ): Promise<void> {
    const { outputHandler, logger } = this.services;

    const existingBase = await Promise.all(
      baseFiles.map((f) => flexibleFS.exists(f)),
    );
    if (!existingBase.some(Boolean)) {
      logger.debug('No base files found for latexdiff');
      return;
    }

    await outputHandler.diffManager.handleLatexdiffofOutput(
      currentRound,
      mapping,
    );
  }
}
