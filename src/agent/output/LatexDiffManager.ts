import { promises as fs } from 'fs';
import * as path from 'path';

import {
  type DiffResult,
  MESSAGE_TYPES,
  type OutputFileInfo,
} from '@shared/schemas';
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { getConfig } from '@utils/config';
import {
  flexibleFS,
  TaskRunFileService,
  type FileLocation,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';
import {
  getComparablePath,
  getFileDirectory,
} from '@utils/files/taskRunStorage';
import { compileLatex2Pdf } from '@latex/texTools';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';

import type { RoundFileMapping } from './types';

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly agentSetting: AgentWorkflowSetting,
    private readonly getOutputFiles: () => { [key: number]: OutputFileInfo[] },
    private readonly baseFiles: FileLocation[],
    private readonly logger: AgentLogger,
    private readonly streamId: string,
    private readonly fileService: TaskRunFileService,
  ) {
    this.latexdiffService = new LaTeXdiffService(streamId);
  }

  private resolveSymlinks(target: string): Promise<string> {
    return fs.realpath(target).catch(() => target);
  }

  private async getWorkingDirectory(location: FileLocation): Promise<string> {
    const resolved = await this.resolveSymlinks(location.absolutePath);
    return path.dirname(resolved);
  }

  private logLatexdiffResult(
    result: LaTeXdiffResult,
    operation: string = 'latexdiff',
  ): void {
    if (result.success) {
      this.logger.debug(
        `Successfully generated ${operation} file: ${result.diffFileName}`,
      );
      return;
    }

    if (result.message && result.message.includes('document environment')) {
      this.logger.debug(`Skipping ${operation}: ${result.message}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      return;
    }

    this.logger.warn(`Failed to generate ${operation}: ${result.message}`, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  private getDisplayLabel(location: FileLocation): string {
    return path.basename(getComparablePath(location));
  }

  private async ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Promise<void> {
    if (!targetLocation) {
      return;
    }

    if (!(await flexibleFS.exists(targetLocation))) {
      return;
    }

    try {
      await this.fileService.mirrorWorkspaceFile(targetLocation);
    } catch (error) {
      this.logger.warn(
        `Unable to mirror workspace dependency ${targetLocation.absolutePath}: ${toErrorMessage(error)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }
  }

  async handleLatexdiffofOutput(
    currRound: number,
    mapping: RoundFileMapping,
    stage?: AgentLogStage,
  ): Promise<void> {
    const execute = () => this.performLatexdiffOperations(currRound, mapping);
    try {
      await (stage ? stage.within(execute) : execute());
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${toErrorMessage(err)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }
  }

  private async performLatexdiffOperations(
    currRound: number,
    mapping: RoundFileMapping,
  ): Promise<void> {
    if (!(await checkToolInstalled('latexdiff'))) {
      this.logger.warn(
        'Skipping latexdiff operations - latexdiff not installed',
      );
      return;
    }

    const outputFiles = this.getOutputFiles()[currRound] ?? [];
    if (outputFiles.length === 0) {
      this.logger.warn(
        `No output files found for round ${currRound}, skipping latexdiff operations`,
      );
      return;
    }

    const outputByPath = new Map(
      outputFiles.map((f) => [getComparablePath(f.location), f]),
    );

    this.logger.debug(
      `Base files: ${this.baseFiles.map((f) => f.absolutePath).join(', ')}`,
    );
    this.logger.debug(
      `r${currRound} output files: ${outputFiles.map((f) => f.location.absolutePath)}`,
    );

    const aggregated: DiffResult[] = [];

    if (this.agentSetting.isRewrite) {
      const basePairs = [...mapping.baseToOutput.entries()];
      this.logPairMatches(basePairs, 'base files to output files');

      for (const [outputPath, baseLocation] of basePairs) {
        const result = await this.runSingleDiff({
          outputPath,
          baseLocation,
          outputByPath,
          originalLocation: baseLocation,
          baseRound: null,
          runDiff: (base, revised, cwd) =>
            this.latexdiffService.runDiffForRound(
              base,
              revised,
              currRound,
              undefined,
              { cwd },
            ),
          label: 'round-diff',
        });
        if (result) aggregated.push(result);
      }
    }

    const generateBetweenRoundDiffs = getConfig<boolean>(
      'texra.latexdiff.generateBetweenRoundDiffs',
      false,
    );

    if (generateBetweenRoundDiffs && currRound > 0) {
      const prevPairs = [...mapping.prevToOutput.entries()];
      this.logPairMatches(
        prevPairs,
        'previous round files to current round files',
      );

      for (const [outputPath, prevLocation] of prevPairs) {
        const originalLocation = mapping.originByOutput.get(outputPath) ?? null;
        const result = await this.runSingleDiff({
          outputPath,
          baseLocation: prevLocation,
          outputByPath,
          originalLocation,
          baseRound: currRound - 1,
          runDiff: (base, revised, cwd) =>
            this.latexdiffService.runDiffBetweenRounds(
              base,
              revised,
              undefined,
              {
                cwd,
              },
            ),
          label: 'between-rounds-diff',
        });
        if (result) aggregated.push(result);
      }
    } else if (!generateBetweenRoundDiffs) {
      this.logger.debug(
        'Skipping between-round latexdiff operations: disabled in settings',
      );
    }

    if (aggregated.length > 0) {
      this.logger.latexDiff(aggregated);
    } else {
      this.logger.debug('No latexdiff results to report');
    }
  }

  private logPairMatches(
    pairs: [string, FileLocation][],
    description: string,
  ): void {
    if (pairs.length > 0) {
      this.logger.debug(
        `Matched ${description}: ${pairs
          .map(
            ([outputPath, loc]) =>
              `${this.getDisplayLabel(loc)} -> ${path.basename(outputPath)}`,
          )
          .join(', ')}`,
      );
    } else if (this.baseFiles.length > 0) {
      this.logger.debug(`No ${description.split(' to ')[0]} mappings found`);
    }
  }

  private async runSingleDiff(params: {
    outputPath: string;
    baseLocation: FileLocation;
    outputByPath: Map<string, OutputFileInfo>;
    originalLocation: FileLocation | null;
    baseRound: number | null;
    runDiff: (
      base: FileLocation,
      revised: FileLocation,
      cwd: string,
    ) => Promise<LaTeXdiffResult>;
    label: string;
  }): Promise<DiffResult | null> {
    const {
      outputPath,
      baseLocation,
      outputByPath,
      originalLocation,
      baseRound,
      runDiff,
      label,
    } = params;

    const revisedFile = outputByPath.get(outputPath);
    if (!revisedFile) {
      this.logger.debug(
        `Skipping diff: output file not found for path ${outputPath}`,
      );
      return null;
    }

    await this.ensureWorkspaceDependency(baseLocation);
    await this.ensureWorkspaceDependency(revisedFile.location);

    const cwd = await this.getWorkingDirectory(revisedFile.location);
    const result = await runDiff(baseLocation, revisedFile.location, cwd);
    this.logLatexdiffResult(result, label);

    const diffLocation = await this.compileDiffIfSuccessful(
      result,
      baseLocation,
    );

    const revisedWithLineage: OutputFileInfo = {
      ...revisedFile,
      lineage: {
        original: originalLocation,
        diffBase: baseLocation,
        diffFile: diffLocation,
      },
    };

    return {
      baseLocation,
      baseRound,
      revised: revisedWithLineage,
      diffLocation,
      status: result.success ? 'success' : 'error',
      message: result.success ? undefined : result.message,
    };
  }

  private async compileDiffIfSuccessful(
    result: LaTeXdiffResult,
    referenceLocation: FileLocation,
  ): Promise<FileLocation | null> {
    if (!result.success || !result.diffFileName) {
      return null;
    }

    const refRelDir = getFileDirectory(referenceLocation);
    const diffRelativePath = path.join(refRelDir, result.diffFileName);
    const diffLocation = this.fileService.createLocation(diffRelativePath);

    const buildDir = path.join(
      path.dirname(diffLocation.absolutePath),
      'build',
    );
    await compileLatex2Pdf(diffLocation, {
      channel: this.streamId,
      outputDirectory: buildDir,
      compiler: 'latexmk',
    });

    return diffLocation;
  }
}
