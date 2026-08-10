import { Node } from '@agent/node';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import type { RoundFileMapping } from '@agent/output/types';
import type { CompiledPdfArtifact } from '@agent/output/compiledPdfArtifacts';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  hasCompileFailures,
  hasRoundOutputs,
  getStorageKey,
  roundsToPersisted,
  setCompileFailures,
  type OutputDependencies,
} from '@agent/output/outputState';
import { runCompileCheck } from '@agent/output/compileCheck';
import { extractFilesFromXml } from '@agent/output/outputFileExtraction';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { resolveBaseFilesForDiff } from '@agent/output/snapshotResolution';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import {
  summarizeRound,
  getRoundOutput,
  type RoundSummary,
} from '@agent/output/roundSummary';
import { formatCompileFailureRoundContext } from '@agent/output/compileFailureRoundContext';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { tryOperation } from '@agent/output/outputOperations';
import {
  MESSAGE_TYPES,
  type AgentFileLocation,
  type CompileFailure,
  type CompileResult,
  type FileLocation,
} from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionServices } from '../ReflectionServices';

interface OutputPrepInput {
  outputLocation: AgentFileLocation;
  currentRound: number;
  endTurn: boolean;
}

interface OutputExecResult {
  summary: RoundSummary;
  compileFailures: CompileFailure[];
  compileResult?: CompileResult;
  compiledArtifacts: CompiledPdfArtifact[];
  emitCompileFailures: boolean;
}

export class OutputNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionServices<C>
> {
  private outputDependencies(): OutputDependencies {
    const { baseFiles, config, fileService, logger, setting, runScope } =
      this.services;
    const { streamId } = runScope;

    return {
      baseFiles,
      config,
      fileService,
      logger,
      interactions: runScope.session.interactions,
      setting,
      streamId,
    };
  }

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
    const outputDependencies = this.outputDependencies();
    const { outputLocation, currentRound, endTurn } = prepRes;

    // Resolve to pre-run snapshots once so mapping, latexdiff, and diff
    // stats all see the same base locations (see snapshotResolution).
    const diffBaseFiles = await resolveBaseFilesForDiff(
      baseFiles,
      outputDependencies.fileService.executionId,
    );

    let mapping: RoundFileMapping | undefined;
    let compileFailures: CompileFailure[] = [];
    let compileRoundResult: CompileResult | undefined;
    const compiledArtifacts: CompiledPdfArtifact[] = [];
    let emitCompileFailures = false;

    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      await tryOperation(
        () => xmlManager.ensureCorrectXmlStructure(outputLocation),
        this.recoverWarn('XML structure'),
      );

      await tryOperation(
        () =>
          extractFilesFromXml(
            outputState,
            outputDependencies,
            xmlManager,
            outputLocation,
            currentRound,
          ),
        this.recoverWarn('Output processing'),
      );

      if (hasRoundOutputs(outputState, currentRound)) {
        const roundMapping = traceFileLineage(
          outputState,
          diffBaseFiles,
          currentRound,
        );
        mapping = roundMapping;

        await tryOperation(async () => {
          const diffArtifacts = await this.handleLatexdiff(
            currentRound,
            diffBaseFiles,
            roundMapping,
            diffManager,
          );
          compiledArtifacts.push(...diffArtifacts);
        }, this.recoverWarn('Latexdiff'));

        await tryOperation(async () => {
          const hadCompileFailures = hasCompileFailures(
            outputState,
            currentRound,
          );
          const compileResult = await runCompileCheck(
            { ...outputDependencies, outputState },
            currentRound,
          );
          compileFailures = compileResult.failures;
          compileRoundResult = compileResult.compileResult;
          compiledArtifacts.push(...compileResult.artifacts);
          setCompileFailures(outputState, currentRound, compileFailures);
          emitCompileFailures =
            compileFailures.length > 0 || hadCompileFailures;
        }, this.recoverWarn('Compile check'));
      }
    }

    // Summarize round (pure data — no events)
    const summary = await summarizeRound(
      outputState,
      outputDependencies,
      outputLocation,
      currentRound,
      {
        endTurn,
        mapping,
        isRewrite: setting.isRewrite,
        baseFiles: diffBaseFiles,
      },
    );

    // Get round output — critical, throw if it fails
    await getRoundOutput(outputState, diffBaseFiles, currentRound, {
      isRewrite: setting.isRewrite,
    });

    return {
      summary,
      compileFailures,
      compileResult: compileRoundResult,
      compiledArtifacts,
      emitCompileFailures,
    };
  }

  async execFallback(
    prepRes: OutputPrepInput,
    error: Error,
  ): Promise<OutputExecResult> {
    const { logger, outputState, setting } = this.services;
    const outputDependencies = this.outputDependencies();
    const { outputLocation, currentRound, endTurn } = prepRes;
    logger.warn(`Output processing failed: ${error.message}`, { data: error });

    // Still summarize what we can for post() side effects
    let summary: RoundSummary;
    try {
      summary = await summarizeRound(
        outputState,
        outputDependencies,
        outputLocation,
        currentRound,
        { endTurn, isRewrite: setting.isRewrite },
      );
    } catch (summaryError) {
      // Double-fault: summarizeRound failed during fallback, so we drop the
      // round's file infos. Log it so silently-missing output files are visible.
      logger.warn(
        `Output fallback summary failed; output files may be dropped: ${toErrorMessage(summaryError)}`,
        { data: summaryError },
      );
      summary = {
        storageKey: getStorageKey(outputState),
        currRound: currentRound,
        fileInfos: [],
        filesToOpen: [],
        outputFile: outputLocation,
        endTurn,
      };
    }

    outputState.rounds.set(currentRound, {
      round: currentRound,
      rawOutput: null,
      outputs: [],
      compileFailures: [],
      xmlSummary: {
        tagContents: {},
        singleOutputFile: null,
        sourceLocation: null,
      },
    });

    return {
      summary,
      compileFailures: [],
      compileResult: undefined,
      compiledArtifacts: [],
      emitCompileFailures: false,
    };
  }

  async post(
    shared: ReflectionFlowShared,
    prepRes: OutputPrepInput,
    execRes: OutputExecResult,
  ): Promise<string | undefined> {
    const { logger, outputState, workflowOutputPolicy } = this.services;
    const outputDependencies = this.outputDependencies();
    const { interactions, streamId } = outputDependencies;
    const { outputLocation, currentRound, endTurn } = prepRes;
    const { summary } = execRes;

    // Emit output files event
    emitRunFact(logger, 'addOutputFiles', {
      streamId,
      filesByRound: { [currentRound]: summary.fileInfos },
    });

    if (execRes.emitCompileFailures) {
      emitRunFact(logger, 'updateCompileFailures', {
        streamId,
        filesByRound: { [currentRound]: execRes.compileFailures },
      });
    }

    // Open files that haven't been opened yet
    for (const location of summary.filesToOpen) {
      interactions.emit('requestOpenFile', { location, preserveFocus: true });
    }

    if (endTurn && workflowOutputPolicy.shouldAutoOpenPdfOrLog()) {
      if (execRes.compileFailures.length > 0) {
        for (const failure of execRes.compileFailures) {
          interactions.emit('requestOpenFile', {
            location: failure.log,
            preserveFocus: true,
          });
        }
      } else {
        for (const artifact of execRes.compiledArtifacts) {
          interactions.emit('requestOpenFile', {
            location: artifact.latestPdf,
            preserveFocus: true,
          });
        }
      }
    }

    // Validate expected outputs if turn ended. checkExpectedOutputs reports
    // the transcript row and the updateMissingOutputs fact together.
    if (endTurn) {
      await tryOperation(async () => {
        const validationResult = await checkExpectedOutputs(
          outputState,
          outputDependencies,
          outputLocation,
          currentRound,
          summary.stage,
        );

        if (validationResult.missing.length > 0) {
          interactions.emit('requestShowInstruction', {
            key: 'missingOutputsInfo',
            message: 'Missing output files detected',
          });
        }
      }, this.recoverWarn('Validate expected outputs'));
    }

    // Project the canonical live collection into PersistedFlow's cloned state.
    shared.roundOutputs = roundsToPersisted(outputState);
    if (execRes.compileResult) {
      shared.lastCompileResult = execRes.compileResult;
      const compileFailureContext = workflowOutputPolicy.shouldRejectOnCompileFailure()
        ? formatCompileFailureRoundContext(execRes.compileResult)
        : undefined;
      if (compileFailureContext) {
        shared.compileFailureContext = compileFailureContext;
      } else {
        delete shared.compileFailureContext;
      }
    } else {
      delete shared.lastCompileResult;
      delete shared.compileFailureContext;
    }

    return FlowTransition.DEFAULT;
  }

  /**
   * Recovery options for {@link tryOperation}: log the failure at `warn` with
   * the DEFAULT message type, then continue. Shared by every best-effort output
   * step so a single failing step never aborts the round.
   */
  private recoverWarn(label: string) {
    return {
      logger: this.services.logger,
      level: 'warn' as const,
      label,
      messageType: MESSAGE_TYPES.DEFAULT,
      recover: () => undefined,
    };
  }

  private async handleLatexdiff(
    currentRound: number,
    baseFiles: FileLocation[],
    mapping: RoundFileMapping,
    diffManager: LatexDiffManager,
  ): Promise<CompiledPdfArtifact[]> {
    const { logger } = this.services;

    const existingBase = await Promise.all(
      baseFiles.map((base) => AbsoluteFS.exists(base.absolutePath)),
    );
    if (!existingBase.some(Boolean)) {
      logger.debug('No base files found for latexdiff');
      return [];
    }

    return diffManager.handleLatexdiffofOutput(currentRound, mapping);
  }
}
