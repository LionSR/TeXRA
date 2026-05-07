import { Node } from '@agent/node';
import type { RoundFileMapping } from '@agent/output/types';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  hasCompileFailures,
  hasRoundOutputs,
  getStorageKey,
  setCompileFailures,
} from '@agent/output/outputState';
import { runCompileCheck } from '@agent/output/compileCheck';
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
import type { CompileFailure, RoundOutput } from '@shared/schemas';
import type { AgentFileLocation, FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

interface OutputPrepInput {
  outputLocation: AgentFileLocation;
  currentRound: number;
  endTurn: boolean;
}

interface OutputExecResult {
  roundOutput: RoundOutput;
  summary: RoundSummary;
  compileFailures: CompileFailure[];
  emitCompileFailures: boolean;
}

/** Execute an operation that can fail gracefully (logs warnings, doesn't throw). */
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
      outputLocation: shared.outputLocation,
      currentRound: shared.currentRound,
      endTurn: shared.endTurn,
    };
  }

  async exec(prepRes: OutputPrepInput): Promise<OutputExecResult> {
    const { outputState, xmlManager, diffManager, setting, logger, baseFiles } =
      this.services;
    const { outputLocation, currentRound, endTurn } = prepRes;

    let mapping: RoundFileMapping | undefined;
    let compileFailures: CompileFailure[] = [];
    let emitCompileFailures = false;

    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      await tryOperation(
        'XML structure',
        () =>
          xmlManager.ensureCorrectXmlStructure(
            outputLocation,
            setting.documentTag,
          ),
        logger,
      );

      await tryOperation(
        'Output processing',
        () =>
          extractFilesFromXml(
            outputState,
            this.services,
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

        await tryOperation(
          'Compile check',
          async () => {
            const hadCompileFailures = hasCompileFailures(
              outputState,
              currentRound,
            );
            compileFailures = await runCompileCheck(
              this.services,
              currentRound,
            );
            setCompileFailures(outputState, currentRound, compileFailures);
            emitCompileFailures =
              compileFailures.length > 0 || hadCompileFailures;
          },
          logger,
        );
      }
    }

    // Summarize round (pure data — no events)
    const summary = await summarizeRound(
      outputState,
      this.services,
      outputLocation,
      currentRound,
      { endTurn, mapping, isRewrite: setting.isRewrite },
    );

    // Get round output — critical, throw if it fails
    const roundOutput = await getRoundOutput(
      outputState,
      baseFiles,
      currentRound,
      { isRewrite: setting.isRewrite },
    );

    return { roundOutput, summary, compileFailures, emitCompileFailures };
  }

  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<OutputExecResult> {
    const { logger, outputState, setting } = this.services;
    const { outputLocation, currentRound, endTurn } = prepRes;
    logger.warn(`Output processing failed: ${error.message}`);

    // Still summarize what we can for post() side effects
    let summary: RoundSummary;
    try {
      summary = await summarizeRound(
        outputState,
        this.services,
        outputLocation,
        currentRound,
        { endTurn, isRewrite: setting.isRewrite },
      );
    } catch {
      summary = {
        storageKey: getStorageKey(outputState),
        currRound: currentRound,
        fileInfos: [],
        filesToOpen: [],
        outputFile: outputLocation,
        endTurn,
      };
    }

    return {
      roundOutput: {
        round: currentRound,
        rawOutput: null,
        outputs: [],
        compileFailures: [],
        xmlSummary: {
          tagContents: {},
          documents: [],
          singleOutputFile: null,
          sourceLocation: null,
        },
      },
      summary,
      compileFailures: [],
      emitCompileFailures: false,
    };
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: OutputPrepInput,
    execRes: OutputExecResult,
  ): Promise<string | undefined> {
    const { streamId, logger, outputState, runtimeHost } = this.services;
    const { outputLocation, currentRound, endTurn } = prepRes;
    const { summary, roundOutput } = execRes;

    // Emit output files event
    runtimeHost.emit('addOutputFiles', {
      streamId,
      filesByRound: { [currentRound]: summary.fileInfos },
    });

    if (execRes.emitCompileFailures) {
      runtimeHost.emit('updateCompileFailures', {
        streamId,
        filesByRound: { [currentRound]: execRes.compileFailures },
      });
    }

    // Open files that haven't been opened yet
    for (const location of summary.filesToOpen) {
      runtimeHost.emit('requestOpenFile', { location, preserveFocus: true });
    }

    // Validate expected outputs if turn ended
    if (endTurn) {
      await tryOperation(
        'Validate expected outputs',
        async () => {
          const validationResult = await checkExpectedOutputs(
            outputState,
            this.services,
            outputLocation,
            currentRound,
            summary.stage,
          );

          runtimeHost.emit('updateMissingOutputs', {
            streamId,
            filesByRound: { [currentRound]: validationResult.missing },
          });

          if (validationResult.missing.length > 0) {
            runtimeHost.emit('requestShowInstruction', {
              key: 'missingOutputsInfo',
              message: 'Missing output files detected',
            });
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
