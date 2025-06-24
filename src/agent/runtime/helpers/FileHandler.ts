// Standard library imports
import * as path from 'path';

// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports
import {
  WorkspaceFS,
  createFileMapping,
  replaceInputCommands,
} from '@utils/files';
import { AgentLogger } from '@logger/AgentLogger';
import { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { OutputHandler, NamedOutputFile } from '@agent/runtime/OutputHandler';
import { getEffectiveBaseFile } from '@utils/files/baseFileUtils';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import {
  getTeXCountStats,
  extractAndCompileTikzPicturesWithLabels,
  compileLatex2Pdf,
} from '@latex';
import type { DiffStats } from '@/types/DiffTypes';

/**
 * Helper responsible for handling file related operations.
 */
export class FileHandler {
  constructor(
    public outputHandler: OutputHandler,
    private agentSetting: AgentSetting,
    private agentConfig: AgentConfig,
    private modelHandler: any,
    private logger: AgentLogger,
    private baseFiles: string[],
  ) {}

  // count lines helper
  private countLines(text: string): number {
    if (text.length === 0) return 0;
    return text.endsWith('\n')
      ? text.split('\n').length - 1
      : text.split('\n').length;
  }

  public async computeDiffStats(
    baseFile: string | null,
    outputFile: string,
  ): Promise<DiffStats> {
    try {
      if (!baseFile) {
        const outContent = await WorkspaceFS.readFile(outputFile);
        const added = this.countLines(outContent);
        return { added };
      }

      const [baseContent, outContent] = await Promise.all([
        WorkspaceFS.readFile(baseFile),
        WorkspaceFS.readFile(outputFile),
      ]);
      const dmp = new diff_match_patch();
      const diffs = dmp.diff_main(baseContent, outContent);
      let added = 0;
      let removed = 0;
      for (const [op, text] of diffs) {
        if (op === 1) {
          added += this.countLines(text);
        } else if (op === -1) {
          removed += this.countLines(text);
        }
      }
      return { added, removed };
    } catch {
      return {};
    }
  }

  public async handleToolStateForOutput(
    outputFiles: string[],
    toolState: ToolState,
  ): Promise<void> {
    if (this.agentConfig.toolConfig.attachTeXCount) {
      toolState.texcountStats = await getTeXCountStats(outputFiles);
    }

    if (
      this.modelHandler.capabilities.supportsVision &&
      this.agentConfig.toolConfig.autoExtractTikzFigure
    ) {
      for (const outputFile of outputFiles) {
        this.logger.debug(`Extracting TikZ figures from ${outputFile}`);
        const extractedTikzFigures =
          await extractAndCompileTikzPicturesWithLabels(outputFile);
        if (extractedTikzFigures) {
          toolState.addMediaFiles(extractedTikzFigures);
        }
      }
    }

    if (
      this.modelHandler.capabilities.supportsVision &&
      this.agentConfig.toolConfig.autoCompileInputPdf
    ) {
      for (const outputFile of outputFiles) {
        if (!outputFile.toLowerCase().endsWith('.tex')) {
          continue;
        }
        const buildDir = path.join(path.dirname(outputFile), 'build');
        const compiled = await compileLatex2Pdf(
          outputFile,
          undefined,
          buildDir,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(outputFile).replace(/\.tex$/, '.pdf'),
          );
          if (await WorkspaceFS.exists(pdfFile)) {
            this.logger.info(
              `Compiled PDF for ${outputFile}: ${pdfFile}`,
              this.logger.getActiveGroupId(),
            );
            toolState.addMediaFiles([pdfFile]);
          }
        }
      }
    }
  }

  public async processOutputFiles(
    outputFile: string,
    currRound: number,
    processGroupId?: string,
  ): Promise<void> {
    const activeGroupId = processGroupId || this.logger.getActiveGroupId();

    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      this.logger.debug(
        `Processing multiple outputs for ${outputFile}; outputFiles: ${this.agentConfig.outputFiles}`,
        activeGroupId,
      );
      try {
        const processedPairs =
          await this.outputHandler.processMultipleXmlOutputs(outputFile);
        if (processedPairs && processedPairs.length > 0) {
          const processedFiles = processedPairs.map((p) => p.path);
          await this.outputHandler.indentLatexFiles(processedFiles);
          this.logger.debug(
            `Indented multiple output files: ${processedFiles.join(',')}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = processedFiles;
          this.outputHandler.outputMappings[currRound] = processedPairs;
          if (this.baseFiles && this.baseFiles.length > 0) {
            await replaceInputCommands(
              this.baseFiles,
              processedFiles,
              this.logger,
            );
          }
        } else {
          this.logger.warn(
            `No processed files were generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = [];
          this.outputHandler.outputMappings[currRound] = [];
        }
      } catch (err) {
        this.logger.error(
          `Error processing output files: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
        );
        this.outputHandler.outputFiles[currRound] = [];
        this.outputHandler.outputMappings[currRound] = [];
      }
    } else {
      this.logger.debug(
        `Processing single output for ${outputFile}`,
        activeGroupId,
      );
      try {
        let processed: NamedOutputFile = {
          source: outputFile,
          path: outputFile,
        };
        if (this.agentSetting.agentType === AgentType.CoT) {
          processed =
            await this.outputHandler.processSingleXmlOutput(outputFile);
        }
        if (processed && processed.path) {
          await this.outputHandler.indentLatexFile(processed.path);
          this.logger.debug(
            `Indented single output file: ${processed.path}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = [processed.path];
          this.outputHandler.outputMappings[currRound] = [processed];
        } else {
          this.logger.warn(
            `No processed file was generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = [];
          this.outputHandler.outputMappings[currRound] = [];
        }
      } catch (err) {
        this.logger.error(
          `Error processing output file: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
        );
        this.outputHandler.outputFiles[currRound] = [];
        this.outputHandler.outputMappings[currRound] = [];
      }
    }
  }

  public async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
    processGroupId: string | undefined,
  ): Promise<string[]> {
    await this.outputHandler.printStatistics(stateGlobal, processGroupId);

    if (
      endTurn &&
      this.outputHandler.outputFiles[currRound] &&
      this.outputHandler.outputFiles[currRound].length > 0
    ) {
      const existingBase = await Promise.all(
        this.baseFiles.map(async (f) => await WorkspaceFS.exists(f)),
      );

      if (existingBase.some((e) => e)) {
        await this.outputHandler.handleLatexdiffofOutput(
          currRound,
          processGroupId,
        );
      } else {
        this.logger.debug(
          `Skipping latexdiff for round ${currRound} - base files missing`,
          processGroupId,
        );
      }
    }

    return this.outputHandler.outputFiles[currRound] || [];
  }

  public async finalizeRound(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    this.logger.debug(`State global: ${JSON.stringify(stateGlobal)}`, groupId);

    await this.handleOutput(
      stateRound,
      stateGlobal,
      outputFile,
      endTurn,
      currRound,
      groupId,
    );

    const provider = ProgressViewProvider.getInstance();
    if (provider) {
      const roundOutputs = this.outputHandler.outputFiles[currRound] || [];

      const baseMap = createFileMapping(
        this.baseFiles,
        roundOutputs,
        'contains',
      );
      const prevMap =
        currRound > 0
          ? createFileMapping(
              this.outputHandler.outputFiles[currRound - 1] || [],
              roundOutputs,
              'basename',
              true,
            )
          : new Map<string, string>();

      const fileInfos: any[] = [];
      const originMap = new Map(
        (this.outputHandler.outputMappings[currRound] || []).map((p) => [
          p.path,
          p.source,
        ]),
      );
      for (const file of roundOutputs) {
        const baseFile =
          Array.from(baseMap.entries()).find(([, out]) => out === file)?.[0] ||
          null;
        const prevFile =
          Array.from(prevMap.entries()).find(([, out]) => out === file)?.[0] ||
          null;
        const originalFile = originMap.get(file) || null;
        const diffBase = getEffectiveBaseFile(baseFile, originalFile, file);
        const stats = await this.computeDiffStats(diffBase, file);
        fileInfos.push({
          path: file,
          base: baseFile,
          prev: prevFile,
          original: originalFile,
          ...stats,
        });
      }

      provider.addOutputFiles(this.logger.channelId, {
        [currRound]: fileInfos,
      });
    }

    this.logger.debug(`Completed round ${currRound}`, groupId);
  }
}
