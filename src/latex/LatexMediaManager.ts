// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - latex utils
import { extractFigurePathsFromLatex } from './extractFigure';
import { tikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';
import { getTeXCountStats } from './texcount';

// Local imports - agent components
import { ToolState } from '@agent/core/ToolState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { WorkspaceFS } from '@utils/files';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(private readonly logger: AgentLogger) {}

  private async attachTeXCount(
    files: string[],
    toolState: ToolState,
    cfg: ToolConfig,
  ): Promise<void> {
    if (cfg.attachTeXCount && files.length > 0) {
      toolState.texcountStats = await getTeXCountStats(files);
    }
  }

  /**
   * Log the loaded media files to the progress view (initial loading status)
   */
  private logLoadedFiles(mediaFiles: string[], groupId?: string): void {
    if (mediaFiles.length === 0) {
      return;
    }

    // Log a message indicating files have been loaded and are ready for processing
    const fileCount = mediaFiles.length;
    const fileLabel = fileCount === 1 ? 'file' : 'files';
    this.logger.info(`Loading ${fileCount} media ${fileLabel}`, groupId);

    // Log the file list with loading status for progress view processing
    // Note: Files are logged as loading initially, final status will be updated after processing
    const mediaFileResults = mediaFiles.map((file) => ({
      path: file,
      ok: null, // null indicates loading state, will be updated with actual results
    }));

    this.logger.info(
      JSON.stringify(mediaFileResults),
      groupId,
      MESSAGE_TYPES.FILE_LIST,
    );
  }

  /**
   * Log the final processing results for media files to the progress view
   */
  public logMediaProcessingResults(mediaFileResults: Array<{ path: string; ok: boolean }>, groupId?: string): void {
    if (mediaFileResults.length === 0) {
      return;
    }

    // Update the progress view with final processing results
    this.logger.info(
      JSON.stringify(mediaFileResults),
      groupId,
      MESSAGE_TYPES.FILE_LIST,
    );

    // Log summary of results
    const successCount = mediaFileResults.filter(r => r.ok).length;
    const failCount = mediaFileResults.length - successCount;
    
    if (failCount > 0) {
      this.logger.warn(`${successCount} media files processed successfully, ${failCount} failed`, groupId);
    } else {
      this.logger.info(`All ${successCount} media files processed successfully`, groupId);
    }
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: string[],
    toolState: ToolState,
    groupId?: string,
  ): Promise<void> {
    const texFiles = files.filter((file) =>
      file.toLowerCase().endsWith('.tex'),
    );
    const compileResults = await Promise.allSettled(
      texFiles.map(async (file) => {
        const buildDir = path.join(path.dirname(file), 'build');
        await WorkspaceFS.ensureDir(buildDir);
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
            return pdfFile;
          }
        }
        return undefined;
      }),
    );
    compileResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        toolState.addMediaFiles([result.value]);
      }
    });
  }

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
    if (!inputFiles || inputFiles.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      inputFiles.map(async (file) => ({
        file,
        exists: await WorkspaceFS.exists(file),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    await this.attachTeXCount(existingFiles, toolState, cfg);

    if (!supportsVision) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      toolState.addMediaFiles(extraMediaFiles);
    }

    if (cfg.autoExtractFigure) {
      const figureResults = await Promise.allSettled(
        existingFiles.map((file) => extractFigurePathsFromLatex(file)),
      );
      figureResults.forEach((result, idx) => {
        if (
          result.status === 'fulfilled' &&
          result.value &&
          result.value.length > 0
        ) {
          const file = existingFiles[idx];
          this.logger.debug(
            `Extracted ${result.value.length} figures from ${file}`,
            groupId,
          );
          toolState.addMediaFiles(result.value);
        }
      });
    }

    if (cfg.autoExtractTikzFigure) {
      const tikzResults = await Promise.allSettled(
        existingFiles.map((file) => tikzPictureManager.compile(file)),
      );
      tikzResults.forEach((result) => {
        if (
          result.status === 'fulfilled' &&
          result.value &&
          result.value.length > 0
        ) {
          toolState.addMediaFiles(result.value);
        }
      });
      this.logger.debug(
        `Extracted ${tikzResults.length} TikZ figures`,
        groupId,
      );
    }

    if (cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }

    // Log all loaded media files immediately after processing
    if (toolState.mediaFiles.length > 0) {
      this.logLoadedFiles(toolState.mediaFiles, groupId);
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
    if (!outputFiles || outputFiles.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      outputFiles.map(async (file) => ({
        file,
        exists: await WorkspaceFS.exists(file),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    await this.attachTeXCount(existingFiles, toolState, cfg);

    if (supportsVision && cfg.autoExtractTikzFigure) {
      const tikzResults = await Promise.allSettled(
        existingFiles.map((file) => tikzPictureManager.compile(file)),
      );
      tikzResults.forEach((result) => {
        if (
          result.status === 'fulfilled' &&
          result.value &&
          result.value.length > 0
        ) {
          toolState.addMediaFiles(result.value);
        }
      });
    }

    if (supportsVision && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }

    // Log all loaded media files immediately after processing
    if (toolState.mediaFiles.length > 0) {
      this.logLoadedFiles(toolState.mediaFiles, groupId);
    }
  }
}
