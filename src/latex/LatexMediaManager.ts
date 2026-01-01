// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TaskRunFileService,
  flexibleFS,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

// Local file imports
import { extractFigurePathsFromLatex } from './extractFigure';
import { tikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';

/**
 * Flexible input type that accepts either a string path or FileLocation.
 * Provides API consistency while maintaining caller convenience.
 */
type PathInput = string | FileLocation;

/** Convert PathInput to FileLocation, handling both string and FileLocation inputs */
function toFileLocation(input: PathInput): FileLocation {
  return typeof input === 'string' ? pathToLocation(input) : input;
}

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(
    private readonly logger: AgentLogger,
    private readonly fileService?: TaskRunFileService,
  ) {}

  private async mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: string[],
    groupId: string | null | undefined,
  ): Promise<void> {
    if (!this.fileService?.hasRunDirectory()) {
      return;
    }

    if (figures.length === 0) {
      return;
    }

    const baseDir = path.dirname(latexFile.absolutePath);
    const targetLocations = new Set<FileLocation>();
    for (const relative of figures) {
      if (!relative) {
        continue;
      }
      const trimmed = relative.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const absolutePath = path.normalize(path.join(baseDir, trimmed));
      // Convert to FileLocation using pathToLocation (boundary conversion)
      targetLocations.add(pathToLocation(absolutePath));
    }

    if (targetLocations.size === 0) {
      return;
    }

    const tasks = Array.from(targetLocations).map(async (targetLocation) => {
      try {
        await this.fileService!.mirrorWorkspaceFile(targetLocation);
      } catch (error) {
        const message = toErrorMessage(error);
        this.logger.debug(
          `Unable to mirror figure dependency ${targetLocation.absolutePath}: ${message}`,
          { groupId: groupId ?? undefined },
        );
      }
    });

    await Promise.all(tasks);
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const texFiles = files.filter((file) =>
      file.absolutePath.toLowerCase().endsWith('.tex'),
    );
    const compileResults = await Promise.allSettled(
      texFiles.map(async (file): Promise<FileLocation | undefined> => {
        const buildDir = path.join(path.dirname(file.absolutePath), 'build');
        await flexibleFS.ensureDir(pathToLocation(buildDir));
        const compiled = await compileLatex2Pdf(
          file,
          undefined,
          buildDir,
          true,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(file.absolutePath).replace(/\.tex$/, '.pdf'),
          );
          const pdfLocation = pathToLocation(pdfFile);
          if (await flexibleFS.exists(pdfLocation)) {
            try {
              const stats = await flexibleFS.stat(pdfLocation);
              if (stats.size === 0) {
                this.logger.warn(
                  `Compiled PDF is empty for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
                  { groupId: activeGroupId },
                );
                return undefined;
              }
            } catch (err) {
              const message = toErrorMessage(err);
              this.logger.error(
                `Failed to stat compiled PDF ${pdfLocation.absolutePath}: ${message}`,
                { groupId: activeGroupId },
              );
              return undefined;
            }

            this.logger.info(
              `Compiled PDF for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
              { groupId: activeGroupId },
            );
            return pdfLocation;
          }
        }
        return undefined;
      }),
    );
    compileResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        workspaceState.media.addMediaFiles([result.value]);
      }
    });
  }

  private async extractFiguresFromFiles(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const figureResults = await Promise.allSettled(
      files.map((file) => extractFigurePathsFromLatex(file)),
    );

    const mirrorTasks: Promise<void>[] = [];

    // Process fulfilled results with non-empty values
    for (const [idx, result] of figureResults.entries()) {
      if (result.status !== 'fulfilled' || !result.value?.length) {
        continue;
      }

      const file = files[idx];
      this.logger.debug(
        `Extracted ${result.value.length} figures from ${file.absolutePath}`,
        { groupId: activeGroupId },
      );

      // result.value contains paths relative to the LaTeX file's directory.
      // We first resolve them to absolute paths by joining with baseDir,
      // then convert to FileLocation (which provides both absolutePath for
      // file operations and relativePath for user display).
      const baseDir = path.dirname(file.absolutePath);
      const fileLocations = result.value.map((relativePath) => {
        const absolutePath = path.normalize(path.join(baseDir, relativePath));
        return pathToLocation(absolutePath);
      });

      // Debug validation: batch existence checks for performance
      // This helps catch figure extraction issues early
      const existenceChecks = await Promise.all(
        fileLocations.map(async (loc) => ({
          loc,
          exists: await flexibleFS.exists(loc),
        })),
      );

      existenceChecks
        .filter(({ exists }) => !exists)
        .forEach(({ loc }) =>
          this.logger.debug(
            `Extracted figure path does not exist: ${loc.absolutePath} (from ${file.absolutePath})`,
            { groupId: activeGroupId },
          ),
        );

      workspaceState.media.addMediaFiles(fileLocations);
      mirrorTasks.push(
        this.mirrorFigureDependencies(file, result.value, activeGroupId),
      );
    }

    if (mirrorTasks.length > 0) {
      await Promise.all(mirrorTasks);
    }
  }

  private async compileTikzFigures(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
    logSummary: boolean,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const tikzResults = await Promise.allSettled(
      files.map((file) => tikzPictureManager.compile(file)),
    );
    // Add successful TikZ compilation results (filter fulfilled with non-empty values)
    tikzResults
      .filter(
        (r): r is PromiseFulfilledResult<FileLocation[]> =>
          r.status === 'fulfilled' && (r.value?.length ?? 0) > 0,
      )
      .forEach((r) => workspaceState.media.addMediaFiles(r.value));
    if (logSummary) {
      this.logger.debug(`Extracted ${tikzResults.length} TikZ figures`, {
        groupId: activeGroupId,
      });
    }
  }

  private async processFiles(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    {
      includeFigureExtraction,
      includeTikzCompilation,
      includePdfCompilation,
      extraMediaFiles = [],
      logTikzSummary = false,
    }: {
      includeFigureExtraction: boolean;
      includeTikzCompilation: boolean;
      includePdfCompilation: boolean;
      extraMediaFiles?: PathInput[];
      logTikzSummary?: boolean;
    },
  ): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      files.map(async (file) => ({
        file,
        exists: await flexibleFS.exists(file),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    if (!supportsVision) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      workspaceState.media.addMediaFiles(extraMediaFiles.map(toFileLocation));
    }

    if (includeFigureExtraction && cfg.autoExtractFigure) {
      await this.extractFiguresFromFiles(existingFiles, workspaceState);
    }

    if (includeTikzCompilation && cfg.autoExtractTikzFigure) {
      await this.compileTikzFigures(
        existingFiles,
        workspaceState,
        logTikzSummary,
      );
    }

    if (includePdfCompilation && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, workspaceState);
    }
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided AgentWorkspaceState.
   *
   * @param extraMediaFiles - Additional media files to include.
   *   Accepts both string paths and FileLocation objects for API flexibility.
   *   Typically user-provided paths from agent config (mediaFile, mediaFiles).
   */
  async processInputFiles(
    inputFiles: FileLocation[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: PathInput[] = [],
  ): Promise<void> {
    await this.processFiles(inputFiles, workspaceState, cfg, supportsVision, {
      includeFigureExtraction: true,
      includeTikzCompilation: true,
      includePdfCompilation: true,
      extraMediaFiles,
      logTikzSummary: true,
    });
  }

  /**
   * Process output files to compile TikZ pictures and PDFs, attach texcount.
   */
  async processOutputFiles(
    outputFiles: FileLocation[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
  ): Promise<void> {
    await this.processFiles(outputFiles, workspaceState, cfg, supportsVision, {
      includeFigureExtraction: false,
      includeTikzCompilation: true,
      includePdfCompilation: true,
    });
  }
}
