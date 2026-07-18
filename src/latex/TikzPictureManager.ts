// Standard library imports
import * as path from 'node:path';

// Local imports - log
import * as logger from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { renderPrompt } from '@utils/prompt';
import { FlexibleFS, TaskRunFileService, pathToLocation } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';

const CHANNEL = 'LaTeXCommands';

/**
 * Pick the run-storage-relative path for a location, falling back to its
 * absolute path for external (non-run-storage) locations.
 */
function runStoragePath(loc: FileLocation): string {
  return loc.kind !== 'external' ? loc.relativePath : loc.absolutePath;
}

class TikzPictureManagerImpl {
  constructor(
    private readonly channel: string = CHANNEL,
    private readonly fileService?: TaskRunFileService,
  ) {}

  /**
   * Create a FileLocation, using fileService if available (run-storage aware),
   * otherwise falling back to a simple path-based location.
   */
  private createLocation(
    relativePath: string,
    absoluteFallback: string,
  ): FileLocation {
    return this.fileService
      ? this.fileService.createLocation(relativePath)
      : pathToLocation(absoluteFallback);
  }

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
   * @returns Array of [label, tikzpictures] tuples
   */
  async extract(latexFile: FileLocation): Promise<[string, string[]][]> {
    const content = await FlexibleFS.read(latexFile);

    // Match each figure block first, then inspect labels inside the block. This
    // prevents an unlabeled figure from consuming a later figure's label.
    const figurePattern =
      /\\begin\{(figure\*?)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
    const labelPattern = /\\label\{([^}]*)\}/;
    const tikzPattern = /\\begin{tikzpicture}.*?\\end{tikzpicture}/gs;

    const labeledTikzPictures: [string, string[]][] = [];

    for (const figureMatch of content.matchAll(figurePattern)) {
      const figureContent = figureMatch[2];
      const label = labelPattern.exec(figureContent)?.[1];
      if (!label) {
        continue;
      }

      // Find all tikzpictures in this figure
      const tikzMatches = [...figureContent.matchAll(tikzPattern)].map(
        (match) => match[0],
      );

      if (tikzMatches.length > 0) {
        labeledTikzPictures.push([label, tikzMatches]);
        logger.debug(this.channel, `Found TikZ picture with label: ${label}`);
      }
    }

    return labeledTikzPictures;
  }

  /**
   * Create a standalone LaTeX file for a TikZ picture
   * @param tikzpictures TikZ picture content
   * @param label Label for the figure
   * @param buildDirLocation Build directory FileLocation
   * @param suffix Optional suffix for multiple pictures with same label
   * @returns FileLocation of created LaTeX file
   */
  async createStandalone(
    tikzpictures: string,
    label: string,
    buildDirLocation: FileLocation,
    suffix?: string,
  ): Promise<FileLocation> {
    const standaloneContent = await renderPrompt(this.getTikzTemplate(), {
      tikzpicture: tikzpictures,
    });

    const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
    const fileRelativePath = path.join(
      runStoragePath(buildDirLocation),
      filename,
    );

    const texLocation = this.createLocation(
      fileRelativePath,
      path.join(buildDirLocation.absolutePath, filename),
    );

    await FlexibleFS.write(texLocation, standaloneContent);
    logger.debug(
      this.channel,
      `Created standalone LaTeX file: ${texLocation.absolutePath}`,
    );

    return texLocation;
  }

  /**
   * Extract and compile TikZ pictures from a LaTeX file
   * @param latexFile Location of the LaTeX file
   * @returns Array of FileLocations for compiled PDF files
   */
  async compile(latexFile: FileLocation): Promise<FileLocation[]> {
    const inputName = path.parse(path.basename(latexFile.absolutePath)).name;
    const inputDir = path.dirname(runStoragePath(latexFile));
    const buildRelativePath = path.join(inputDir, 'build', inputName);

    const buildDirLocation = this.createLocation(
      buildRelativePath,
      path.join(path.dirname(latexFile.absolutePath), 'build', inputName),
    );

    await FlexibleFS.ensureDir(buildDirLocation);

    logger.debug(
      this.channel,
      `Extracting TikZ pictures from ${latexFile.absolutePath}`,
    );
    const labeledTikzPictures = await this.extract(latexFile);
    logger.debug(
      this.channel,
      `Found ${labeledTikzPictures.length} labeled TikZ pictures`,
    );

    const compiledFiles: FileLocation[] = [];

    for (const [label, tikzpicturess] of labeledTikzPictures) {
      const hasMultiple = tikzpicturess.length > 1;

      for (const [i, tikzpictures] of tikzpicturess.entries()) {
        // Disambiguate multiple pictures under one label with a/b/c… suffixes.
        const suffix = hasMultiple ? String.fromCharCode(97 + i) : undefined;

        const texLocation = await this.createStandalone(
          tikzpictures,
          label,
          buildDirLocation,
          suffix,
        );
        const compiled = await compileLatex2Pdf(texLocation, {
          channel: this.channel,
          compiler: 'pdflatex',
        });
        if (!compiled.ok) {
          logger.warn(
            this.channel,
            `Failed to compile TikZ picture ${texLocation.absolutePath}:\n${compiled.logTail}`,
            {
              data: {
                texFile: texLocation.absolutePath,
                logTail: compiled.logTail,
              },
            },
          );
        }

        // Derive PDF location from tex location
        const pdfFilename = path
          .basename(texLocation.absolutePath)
          .replace(/\.tex$/, '.pdf');
        const texDir = path.dirname(runStoragePath(texLocation));
        const pdfRelativePath = path.join(texDir, pdfFilename);

        const pdfLocation = this.createLocation(
          pdfRelativePath,
          path.join(path.dirname(texLocation.absolutePath), pdfFilename),
        );

        if (await FlexibleFS.exists(pdfLocation)) {
          compiledFiles.push(pdfLocation);
          logger.debug(
            this.channel,
            `Successfully compiled: ${pdfLocation.absolutePath}`,
          );
        }
      }
    }

    return compiledFiles;
  }
}

export const TikzPictureManager = new TikzPictureManagerImpl();
