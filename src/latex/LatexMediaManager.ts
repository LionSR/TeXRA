// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - latex utils
import {
  extractFigurePathsFromLatex,
  tikzPictureManager,
  compileLatex2Pdf,
  getTeXCountStats,
} from '@latex';

// Local imports - agent components
import { ToolState } from '@agent/core/ToolState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { WorkspaceFS } from '@utils/files';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(private readonly logger: AgentLogger) {}

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided ToolState.
   */
  async processInputFiles(
    inputFiles: string[],
    toolState: ToolState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: string[] = [],
    groupId?: string,
  ): Promise<void> {
    if (cfg.attachTeXCount) {
      toolState.texcountStats = await getTeXCountStats(inputFiles);
    }

    if (!supportsVision) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      toolState.addMediaFiles(extraMediaFiles);
    }

    if (cfg.autoExtractFigure) {
      for (const file of inputFiles) {
        const extracted = await extractFigurePathsFromLatex(file);
        if (extracted && extracted.length > 0) {
          this.logger.info(
            `Extracted ${extracted.length} figures from ${file}`,
            groupId,
          );
          toolState.addMediaFiles(extracted);
        }
      }
    }

    if (cfg.autoExtractTikzFigure) {
      for (const file of inputFiles) {
        const tikzFigures = await tikzPictureManager.compile(file);
        if (tikzFigures && tikzFigures.length > 0) {
          toolState.addMediaFiles(tikzFigures);
        }
      }
    }

    if (cfg.autoCompileInputPdf) {
      for (const file of inputFiles) {
        if (!file.toLowerCase().endsWith('.tex')) {
          continue;
        }
        const buildDir = path.join(path.dirname(file), 'build');
        const compiled = await compileLatex2Pdf(
          file,
          undefined,
          buildDir,
          true,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(file).replace(/\.tex$/, '.pdf'),
          );
          if (await WorkspaceFS.exists(pdfFile)) {
            this.logger.info(`Compiled PDF for ${file}: ${pdfFile}`, groupId);
            toolState.addMediaFiles([pdfFile]);
          }
        }
      }
    }
  }

  /**
   * Process output files to compile TikZ pictures and PDFs, attach texcount.
   */
  async processOutputFiles(
    outputFiles: string[],
    toolState: ToolState,
    cfg: ToolConfig,
    supportsVision: boolean,
    groupId?: string,
  ): Promise<void> {
    if (cfg.attachTeXCount) {
      toolState.texcountStats = await getTeXCountStats(outputFiles);
    }

    if (supportsVision && cfg.autoExtractTikzFigure) {
      for (const outputFile of outputFiles) {
        const tikzFigures = await tikzPictureManager.compile(outputFile);
        if (tikzFigures && tikzFigures.length > 0) {
          toolState.addMediaFiles(tikzFigures);
        }
      }
    }

    if (supportsVision && cfg.autoCompileInputPdf) {
      for (const outputFile of outputFiles) {
        if (!outputFile.toLowerCase().endsWith('.tex')) {
          continue;
        }
        const buildDir = path.join(path.dirname(outputFile), 'build');
        const compiled = await compileLatex2Pdf(
          outputFile,
          undefined,
          buildDir,
          true,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(outputFile).replace(/\.tex$/, '.pdf'),
          );
          if (await WorkspaceFS.exists(pdfFile)) {
            this.logger.info(
              `Compiled PDF for ${outputFile}: ${pdfFile}`,
              groupId,
            );
            toolState.addMediaFiles([pdfFile]);
          }
        }
      }
    }
  }
}
