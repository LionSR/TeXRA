import * as path from 'path';

import { Node } from '@agent/node';
import { getConfig } from '@agent/core/config';
import type { RoundFileMapping } from '@agent/output/types';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  hasRoundOutputs,
  getStorageKey,
  getOutputFilesByRound,
} from '@agent/output/outputState';
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
import { bus } from '@eventBus/ProgressEventBus';
import { compileLatex2Pdf } from '@latex/texTools';
import type { RoundOutput } from '@shared/schemas';
import type { AgentFileLocation, FileLocation } from '@utils/files';
import { flexibleFS, getComparablePath, pathToLocation } from '@utils/files';

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
    const {
      outputState,
      xmlManager,
      diffManager,
      setting,
      logger,
      baseFiles,
      shouldEnsureXmlStructure: shouldEnsureXml,
    } = this.services;
    const { outputLocation, currentRound, endTurn } = prepRes;

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
          () => this.handleCompileCheck(currentRound),
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

    return { roundOutput, summary };
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

  async post(
    shared: ReflectionFlowShared,
    prepRes: OutputPrepInput,
    execRes: OutputExecResult,
  ): Promise<string | undefined> {
    const { streamId, logger, outputState } = this.services;
    const { outputLocation, currentRound, endTurn } = prepRes;
    const { summary, roundOutput } = execRes;

    // Emit output files event
    bus.emit('addOutputFiles', {
      streamId,
      storageKey: summary.storageKey,
      filesByRound: { [currentRound]: summary.fileInfos },
    });

    // Open files that haven't been opened yet
    for (const location of summary.filesToOpen) {
      bus.emit('requestOpenFile', { location, preserveFocus: true });
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

          bus.emit('updateMissingOutputs', {
            streamId,
            storageKey: validationResult.storageKey,
            filesByRound: { [currentRound]: validationResult.missing },
          });

          if (validationResult.missing.length > 0) {
            bus.emit('requestShowInstruction', {
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

  /**
   * Attempt to compile each .tex output so the orchestrator (or user) knows
   * whether the workflow produced a buildable document. On failure, the last
   * 200 lines of the LaTeX log are written to
   * `<runDir>/compile/<name>.log`; on success no log file is written.
   *
   * Missing toolchains, empty run directories, and non-root fragments all
   * short-circuit to a debug log and skip the file gracefully.
   */
  private async handleCompileCheck(currentRound: number): Promise<void> {
    const { fileService, outputState, logger, streamId } = this.services;

    if (!getConfig<boolean>('texra.workflow.autoCompileAfterOutput', true)) {
      return;
    }

    const runDirectory = fileService.metadata.runDirectory;
    if (!runDirectory) {
      logger.debug('Compile check skipped: no run directory for this execution');
      return;
    }

    const outputs = getOutputFilesByRound(outputState)[currentRound] ?? [];
    const texOutputs = outputs.filter((f) =>
      f.location.absolutePath.toLowerCase().endsWith('.tex'),
    );
    if (texOutputs.length === 0) {
      return;
    }

    const timeoutMs = Math.max(
      10000,
      getConfig<number>('texra.workflow.autoCompileTimeoutMs', 120000),
    );
    const compileRoot = path.join(runDirectory, 'compile');
    await flexibleFS.ensureDir(pathToLocation(compileRoot));

    for (const outputFile of texOutputs) {
      const displayName = path.basename(outputFile.location.absolutePath);
      // Derive a unique identifier from the full relative (or absolute) path so
      // two outputs sharing a basename (e.g. ch1/main.tex and ch2/main.tex)
      // don't clobber each other's build dirs and log files.
      const safeName = getComparablePath(outputFile.location).replaceAll(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );
      const buildDir = path.join(
        compileRoot,
        'build',
        `r${currentRound}`,
        safeName,
      );
      const logDest = pathToLocation(path.join(compileRoot, `${safeName}.log`));

      await flexibleFS.delete(logDest).catch(() => undefined);

      let content: string;
      try {
        content = await flexibleFS.read(outputFile.location);
      } catch (err) {
        logger.debug(
          `Compile check: cannot read ${displayName}: ${toErrorMessage(err)}`,
        );
        continue;
      }
      if (!/\\documentclass/.test(content)) {
        logger.debug(
          `Compile check: ${displayName} has no \\documentclass, skipping fragment`,
        );
        continue;
      }

      let ok = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const compile = compileLatex2Pdf(outputFile.location, {
          channel: streamId,
          outputDirectory: buildDir,
        });
        const timeout = new Promise<boolean>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`compile timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });
        ok = await Promise.race<boolean>([compile, timeout]);
      } catch (err) {
        const message = toErrorMessage(err);
        logger.warn(`Compile check: ${displayName} aborted — ${message}`);
        await flexibleFS.write(
          logDest,
          `Compile check aborted for ${displayName}: ${message}\n`,
        );
        continue;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (ok) {
        logger.debug(`Compile check: ${displayName} built successfully`);
        continue;
      }

      // Latex engines write `<basename-without-ext>.log` in the build dir.
      // Strip the extension case-insensitively so `.TEX`/`.Tex` inputs resolve
      // to the same log path as `.tex` ones.
      const latexLogAbs = path.join(
        buildDir,
        `${displayName.replace(/\.tex$/i, '')}.log`,
      );
      let tail: string;
      try {
        const full = await flexibleFS.read(pathToLocation(latexLogAbs));
        tail = full.split('\n').slice(-200).join('\n');
      } catch {
        tail =
          '(no LaTeX log produced — toolchain may be missing or failed before writing a log)';
      }

      const header =
        `Compile check failed for ${displayName}\n` +
        `Build directory: ${buildDir}\n` +
        `Last 200 lines of the LaTeX log follow:\n` +
        `${'-'.repeat(60)}\n`;
      await flexibleFS.write(logDest, `${header}${tail}\n`);
      logger.warn(
        `Compile check: ${displayName} failed — wrote ${path.relative(runDirectory, logDest.absolutePath)}`,
      );
    }
  }
}
