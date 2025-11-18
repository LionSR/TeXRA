// Standard library imports
import * as path from 'path';

// Third-party imports
import * as nunjucks from 'nunjucks';

// Local imports - log
import { renderPrompt } from '@agent/utils/promptUtils';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  flexibleFS,
  TaskRunFileService,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { getConfig } from '@utils/config';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Configure nunjucks
nunjucks.configure({ autoescape: false });

export class TikzPictureManager {
  constructor(
    private readonly channel: string = CHANNEL,
    private readonly fileService?: TaskRunFileService,
  ) {}

  /**
   * Get the TikZ template from configuration or use default
   * @returns The TikZ template string
   */
  private getTikzTemplate(): string {
    return getConfig<string>(
      'texra.latex.tikzTemplate',
      `
  \\documentclass[tikz,border=10pt]{standalone}
  \\usepackage{tikz}
  \\usepackage{pgfplots}
  \\usetikzlibrary{positioning}
  \\usetikzlibrary{patterns}
  \\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}
  \\usetikzlibrary{shapes, arrows}

  \\begin{document}
  {{ tikzpicture }}
  \\end{document}
  `,
    );
  }

  /**
   * Extract TikZ pictures with their labels from a LaTeX file
   * @param latexFile FileLocation of the LaTeX file
   * @param channel Optional channel for logging
   * @returns Array of [label, tikzpictures] tuples
   */
  async extract(
    latexFile: FileLocation,
    channel: string = this.channel,
  ): Promise<[string, string[]][]> {
    try {
      const content = await flexibleFS.read(latexFile);

      // Regular expressions to match figure environments and tikzpictures
      const figurePattern =
        /\\begin{figure}.*?\\label\{(.*?)\}.*?\\end{figure}/gs;
      const tikzPattern = /\\begin{tikzpicture}.*?\\end{tikzpicture}/gs;

      const labeledTikzPictures: [string, string[]][] = [];

      let figureMatch;
      while ((figureMatch = figurePattern.exec(content)) !== null) {
        const figureContent = figureMatch[0];
        const label = figureMatch[1];

        // Find all tikzpictures in this figure
        const tikzMatches = [...figureContent.matchAll(tikzPattern)].map(
          (match) => match[0],
        );

        if (tikzMatches.length > 0) {
          labeledTikzPictures.push([label, tikzMatches]);
          logger.debug(channel, `Found TikZ picture with label: ${label}`);
        }
      }

      return labeledTikzPictures;
    } catch (err) {
      logger.error(
        channel,
        `Error extracting TikZ pictures: ${toErrorMessage(err)}`,
      );
      throw err;
    }
  }

  /**
   * Create a standalone LaTeX file for a TikZ picture
   * @param tikzpictures TikZ picture content
   * @param label Label for the figure
   * @param buildDirLocation Build directory FileLocation
   * @param suffix Optional suffix for multiple pictures with same label
   * @param channel Optional channel for logging
   * @returns FileLocation of created LaTeX file
   */
  async createStandalone(
    tikzpictures: string,
    label: string,
    buildDirLocation: FileLocation,
    suffix?: string,
    channel: string = this.channel,
  ): Promise<FileLocation> {
    try {
      const standaloneContent = await renderPrompt(this.getTikzTemplate(), {
        tikzpicture: tikzpictures,
      });

      const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
      const buildDir =
        buildDirLocation.kind !== 'external'
          ? buildDirLocation.relativePath
          : buildDirLocation.absolutePath;
      const fileRelativePath = path.join(buildDir, filename);

      // Use fileService if available (run-storage aware), otherwise create workspace location
      const texLocation = this.fileService
        ? this.fileService.createLocation(fileRelativePath)
        : pathToLocation(path.join(buildDirLocation.absolutePath, filename)); // Fallback: create proper file location

      await flexibleFS.write(texLocation, standaloneContent);
      logger.debug(
        channel,
        `Created standalone LaTeX file: ${texLocation.absolutePath}`,
      );

      return texLocation;
    } catch (err) {
      logger.error(
        channel,
        `Error creating standalone LaTeX: ${toErrorMessage(err)}`,
      );
      throw err;
    }
  }

  /**
   * Extract and compile TikZ pictures from a LaTeX file
   * @param latexFile Location of the LaTeX file
   * @param channel Optional channel for logging
   * @returns Array of FileLocations for compiled PDF files
   */
  async compile(
    latexFile: FileLocation,
    channel: string = this.channel,
  ): Promise<FileLocation[]> {
    try {
      const inputName = path.parse(path.basename(latexFile.absolutePath)).name;
      const inputDir =
        latexFile.kind !== 'external'
          ? path.dirname(latexFile.relativePath)
          : path.dirname(latexFile.absolutePath);
      const buildRelativePath = path.join(inputDir, 'build', inputName);

      // Create build directory location (run-storage aware if fileService available)
      const buildDirLocation = this.fileService
        ? this.fileService.createLocation(buildRelativePath)
        : latexFile; // Fallback

      await flexibleFS.ensureDir(buildDirLocation);

      logger.debug(
        channel,
        `Extracting TikZ pictures from ${latexFile.absolutePath}`,
      );
      const labeledTikzPictures = await this.extract(latexFile, channel);
      logger.debug(
        channel,
        `Found ${labeledTikzPictures.length} labeled TikZ pictures`,
      );

      const compiledFiles: FileLocation[] = [];

      for (const [label, tikzpicturess] of labeledTikzPictures) {
        const suffixes =
          tikzpicturess.length > 1
            ? tikzpicturess.map((_, i) => String.fromCharCode(97 + i))
            : [undefined];

        for (let i = 0; i < tikzpicturess.length; i++) {
          const tikzpictures = tikzpicturess[i];
          const suffix = suffixes[i];

          const texLocation = await this.createStandalone(
            tikzpictures,
            label,
            buildDirLocation,
            suffix,
            channel,
          );
          await compileLatex2Pdf(texLocation, channel);

          // Derive PDF location from tex location
          const pdfFilename = path
            .basename(texLocation.absolutePath)
            .replace(/\.tex$/, '.pdf');
          const texDir =
            texLocation.kind !== 'external'
              ? path.dirname(texLocation.relativePath)
              : path.dirname(texLocation.absolutePath);
          const pdfRelativePath = path.join(texDir, pdfFilename);

          const pdfLocation = this.fileService
            ? this.fileService.createLocation(pdfRelativePath)
            : pathToLocation(
                path.join(path.dirname(texLocation.absolutePath), pdfFilename),
              ); // Fallback: create proper PDF location

          if (await flexibleFS.exists(pdfLocation)) {
            compiledFiles.push(pdfLocation);
            logger.debug(
              channel,
              `Successfully compiled: ${pdfLocation.absolutePath}`,
            );
          }
        }
      }

      return compiledFiles;
    } catch (err) {
      logger.error(
        channel,
        `Error extracting and compiling TikZ pictures: ${toErrorMessage(err)}`,
      );
      throw err;
    }
  }
}

export const tikzPictureManager = new TikzPictureManager();
