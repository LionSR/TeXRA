/**
 * OutputNode - Handles output processing after response cycle.
 *
 * Processes output files, handles latexdiff, and finalizes round artifacts.
 * Non-critical operations can fail gracefully (logged as warnings).
 *
 * This node is responsible for:
 * - Event emission (bus.emit('addOutputFiles', ...), bus.emit('updateMissingOutputs', ...))
 * - File opening logic (openBuildDisplayIfTex)
 * - Validation decisions (when to validate and how to handle results)
 */

import { Node } from '@agent/node';
import type { RoundFileMapping } from '@agent/output/types';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { toErrorMessage } from '@common/errors';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import type { AgentFileLocation, FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';
import { bus } from '@eventBus/ProgressEventBus';
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
    const {
      outputHandler,
      setting,
      logger,
      baseFiles,
      shouldEnsureXmlStructure,
      streamId,
    } = this.services;
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

    // Finalize round and get data for event emission/file opening
    const finalizeResult = await outputHandler.finalizeRound(
      outputLocation,
      currentRound,
      { endTurn, mapping },
    );

    // Emit addOutputFiles event (moved from OutputHandler)
    bus.emit('addOutputFiles', {
      streamId,
      storageKey: finalizeResult.storageKey,
      filesByRound: { [currentRound]: finalizeResult.fileInfos },
    });

    // Open files that haven't been opened yet (moved from OutputHandler)
    for (const location of finalizeResult.filesToOpen) {
      await tryOperation(
        `Open file ${location.absolutePath}`,
        () => openBuildDisplayIfTex(location, { preserveFocus: true }),
        logger,
      );
    }

    // Validate expected outputs if turn ended (moved from OutputHandler)
    if (endTurn) {
      await tryOperation(
        'Validate expected outputs',
        async () => {
          const validationResult = await outputHandler.validateExpectedOutputs(
            outputLocation,
            currentRound,
            finalizeResult.stage,
          );

          // Emit updateMissingOutputs event
          bus.emit('updateMissingOutputs', {
            streamId,
            storageKey: validationResult.storageKey,
            filesByRound: { [currentRound]: validationResult.missing },
          });

          // Show instruction if there are missing outputs
          if (validationResult.missing.length > 0) {
            await showInstructionWithSuppress(
              'missingOutputsInfo',
              'Missing output files detected',
            );
          }
        },
        logger,
      );
    }

    // Get round artifacts - this is critical, throw if it fails
    return await outputHandler.getRoundArtifacts(currentRound);
  }

  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<RoundOutput> {
    const { logger } = this.services;
    logger.warn(`Output processing failed: ${error.message}`);
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
