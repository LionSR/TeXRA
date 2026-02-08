/**
 * OutputNode - Handles output processing after response cycle.
 *
 * Processes output files, handles latexdiff, and finalizes round artifacts.
 * Non-critical operations can fail gracefully (logged as warnings).
 *
 * PocketFlow compliance:
 * - prep(): Extracts data from shared (output location, round info)
 * - exec(): Pure computation — XML processing, file extraction, latexdiff, summary
 * - post(): All side effects — event emission, file opening, validation, state updates
 */

import { Node } from '@agent/node';
import type { RoundFileMapping } from '@agent/output/types';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import { hasRoundOutputs } from '@agent/output/outputState';
import { extractFilesFromXml } from '@agent/output/xmlExtraction';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import {
  summarizeRound,
  getRoundOutput,
  type RoundSummary,
} from '@agent/output/roundSummary';
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

/** Exec result bundles both the round output and the summary for post() side effects. */
interface OutputExecResult {
  roundOutput: RoundOutput;
  summary: RoundSummary;
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

  /**
   * Pure computation: XML processing, file extraction, latexdiff, round summary.
   * No event emission, no file opening, no UI notifications.
   */
  async exec(prepRes: OutputPrepInput): Promise<OutputExecResult> {
    const {
      outputState,
      outputDeps,
      xmlManager,
      diffManager,
      setting,
      logger,
      baseFiles,
      shouldEnsureXmlStructure: shouldEnsureXml,
    } = this.services;
    const { shared, outputLocation } = prepRes;
    const { currentRound, endTurn } = shared;

    let mapping: RoundFileMapping | undefined;

    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      if (shouldEnsureXml) {
        await tryOperation(
          'XML structure',
          () =>
            xmlManager.ensureCorrectXmlStructure(
              outputLocation,
              setting.documentTag,
            ),
          logger,
        );
      }

      await tryOperation(
        'Output processing',
        () =>
          extractFilesFromXml(
            outputState,
            outputDeps,
            xmlManager,
            outputLocation,
            currentRound,
          ),
        logger,
      );

      if (hasRoundOutputs(outputState, currentRound)) {
        mapping = traceFileLineage(outputState, baseFiles, currentRound);

        await tryOperation(
          'Latexdiff',
          () =>
            this.handleLatexdiff(
              currentRound,
              baseFiles,
              mapping!,
              diffManager,
            ),
          logger,
        );
      }
    }

    // Summarize round (pure data — no events)
    const summary = await summarizeRound(
      outputState,
      outputDeps,
      outputLocation,
      currentRound,
      { endTurn, mapping },
    );

    // Get round output — critical, throw if it fails
    const roundOutput = await getRoundOutput(
      outputState,
      baseFiles,
      currentRound,
    );

    return { roundOutput, summary };
  }

  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<OutputExecResult> {
    const { logger, outputState, outputDeps } = this.services;
    const { shared, outputLocation } = prepRes;
    logger.warn(`Output processing failed: ${error.message}`);

    // Still summarize what we can for post() side effects
    let summary: RoundSummary;
    try {
      summary = await summarizeRound(
        outputState,
        outputDeps,
        outputLocation,
        shared.currentRound,
        { endTurn: shared.endTurn },
      );
    } catch {
      summary = {
        storageKey: '' as any,
        currRound: shared.currentRound,
        fileInfos: [],
        filesToOpen: [],
        outputFile: outputLocation,
        endTurn: shared.endTurn,
      };
    }

    return {
      roundOutput: {
        round: shared.currentRound,
        rawOutput: null,
        outputs: [],
        xmlSummary: {
          tagContents: {},
          documents: [],
          singleOutputFile: null,
          sourceLocation: null,
        },
      },
      summary,
    };
  }

  /**
   * All side effects: event emission, file opening, validation, state updates.
   */
  async post(
    _shared: ReflectionFlowShared,
    prepRes: OutputPrepInput,
    execRes: OutputExecResult,
  ): Promise<string | undefined> {
    const { streamId, logger, outputState, outputDeps } = this.services;
    const { shared, outputLocation } = prepRes;
    const { currentRound, endTurn } = shared;
    const { summary, roundOutput } = execRes;

    // Emit output files event
    bus.emit('addOutputFiles', {
      streamId,
      storageKey: summary.storageKey,
      filesByRound: { [currentRound]: summary.fileInfos },
    });

    // Open files that haven't been opened yet
    for (const location of summary.filesToOpen) {
      await tryOperation(
        `Open file ${location.absolutePath}`,
        () => openBuildDisplayIfTex(location, { preserveFocus: true }),
        logger,
      );
    }

    // Validate expected outputs if turn ended
    if (endTurn) {
      await tryOperation(
        'Validate expected outputs',
        async () => {
          const validationResult = await checkExpectedOutputs(
            outputState,
            outputDeps,
            outputLocation,
            currentRound,
            summary.stage,
          );

          bus.emit('updateMissingOutputs', {
            streamId,
            storageKey: validationResult.storageKey,
            filesByRound: { [currentRound]: validationResult.missing },
          });

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

    // Store round output
    shared.roundOutputs[currentRound] = roundOutput;

    return FlowTransition.DEFAULT;
  }

  private async handleLatexdiff(
    currentRound: number,
    baseFiles: FileLocation[],
    mapping: RoundFileMapping,
    diffManager: LatexDiffManager,
  ): Promise<void> {
    const { logger } = this.services;

    const existingBase = await Promise.all(
      baseFiles.map((f) => flexibleFS.exists(f)),
    );
    if (!existingBase.some(Boolean)) {
      logger.debug('No base files found for latexdiff');
      return;
    }

    await diffManager.handleLatexdiffofOutput(currentRound, mapping);
  }
}
