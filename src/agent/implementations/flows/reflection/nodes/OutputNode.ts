import { Node } from '@agent/node';
import type { RoundFileMapping } from '@agent/output/types';
import type { CompiledPdfArtifact } from '@agent/output/compiledPdfArtifacts';
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
import { resolveBaseFilesForDiff } from '@agent/output/snapshotResolution';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import {
  summarizeRound,
  getRoundOutput,
  type RoundSummary,
} from '@agent/output/roundSummary';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { getWorkspaceState } from '@agent/core/stateStore';
import { toErrorMessage } from '@common/errors';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import type { CompileFailure, RoundOutput } from '@shared/schemas';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
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
  compiledArtifacts: CompiledPdfArtifact[];
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

    // Resolve to pre-run snapshots once so mapping, latexdiff, and diff
    // stats all see the same base locations (see snapshotResolution).
    const diffBaseFiles = await resolveBaseFilesForDiff(
      baseFiles,
      this.services.executionId,
    );

    let mapping: RoundFileMapping | undefined;
    let compileFailures: CompileFailure[] = [];
    const compiledArtifacts: CompiledPdfArtifact[] = [];
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
        mapping = traceFileLineage(outputState, diffBaseFiles, currentRound);

        await tryOperation(
          'Latexdiff',
          async () => {
            const diffArtifacts = await this.handleLatexdiff(
              currentRound,
              diffBaseFiles,
              mapping!,
              diffManager,
            );
            compiledArtifacts.push(...diffArtifacts);
          },
          logger,
        );

        await tryOperation(
          'Compile check',
          async () => {
            const hadCompileFailures = hasCompileFailures(
              outputState,
              currentRound,
            );
            const compileResult = await runCompileCheck(
              this.services,
              currentRound,
            );
            compileFailures = compileResult.failures;
            compiledArtifacts.push(...compileResult.artifacts);
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
      {
        endTurn,
        mapping,
        isRewrite: setting.isRewrite,
        baseFiles: diffBaseFiles,
      },
    );

    // Get round output — critical, throw if it fails
    const roundOutput = await getRoundOutput(
      outputState,
      diffBaseFiles,
      currentRound,
      { isRewrite: setting.isRewrite },
    );

    return {
      roundOutput,
      summary,
      compileFailures,
      compiledArtifacts,
      emitCompileFailures,
    };
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
      compiledArtifacts: [],
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

    if (endTurn && shouldAutoOpenPdfOrLog()) {
      if (execRes.compileFailures.length > 0) {
        for (const failure of execRes.compileFailures) {
          runtimeHost.emit('requestOpenFile', {
            location: failure.log,
            preserveFocus: true,
          });
        }
      } else {
        for (const artifact of execRes.compiledArtifacts) {
          runtimeHost.emit('requestOpenFile', {
            location: artifact.latestPdf,
            preserveFocus: true,
          });
        }
      }
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
  ): Promise<CompiledPdfArtifact[]> {
    const { logger } = this.services;

    const existingBase = await Promise.all(
      baseFiles.map((base) => flexibleFS.exists(base)),
    );
    if (!existingBase.some(Boolean)) {
      logger.debug('No base files found for latexdiff');
      return [];
    }

    return diffManager.handleLatexdiffofOutput(currentRound, mapping);
  }
}

function shouldAutoOpenPdfOrLog(): boolean {
  return getWorkspaceState().get<boolean>(
    WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf,
  );
}
