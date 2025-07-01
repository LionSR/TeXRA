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
  private loggedFiles = new Set<string>();
  
  constructor(private readonly logger: AgentLogger) {}

  /**
   * Reset the logged files tracking for a new processing session
   */
  public resetLoggedFiles(): void {
    this.loggedFiles.clear();
  }

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
   * Log newly discovered media files immediately with loading status
   */
  private logNewlyDiscoveredFiles(newFiles: string[], groupId?: string): void {
    if (newFiles.length === 0) {
      return;
    }

    // Filter out files that have already been logged
    const unloggedFiles = newFiles.filter(file => !this.loggedFiles.has(file));
    
    if (unloggedFiles.length === 0) {
      return;
    }

    // Mark files as logged
    unloggedFiles.forEach(file => this.loggedFiles.add(file));

    // Log a message indicating files have been discovered
    const fileCount = unloggedFiles.length;
    const fileLabel = fileCount === 1 ? 'file' : 'files';
    this.logger.info(`Discovered ${fileCount} media ${fileLabel}`, groupId);

    // Log the file list with loading status for progress view processing
    const mediaFileResults = unloggedFiles.map((file) => ({
      path: file,
      ok: null, // null indicates loading/discovery state, final status will be updated after processing
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
        // Log newly compiled PDF files immediately
        this.logNewlyDiscoveredFiles([result.value], groupId);
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
      // Log newly added extra media files immediately
      this.logNewlyDiscoveredFiles(extraMediaFiles, groupId);
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
          // Log newly extracted figure files immediately
          this.logNewlyDiscoveredFiles(result.value, groupId);
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
          // Log newly compiled TikZ files immediately
          this.logNewlyDiscoveredFiles(result.value, groupId);
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

    // Note: Files are logged immediately when discovered/added above
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
          // Log newly compiled TikZ files immediately
          this.logNewlyDiscoveredFiles(result.value, groupId);
        }
      });
    }

    if (supportsVision && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }

    // Note: Files are logged immediately when discovered/added above
  }
}
