// Standard library imports
import * as path from 'node:path';

// Local imports - log
import { createLog } from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { renderPrompt } from '@utils/prompt';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { getConfig } from '@utils/config/configUtils';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

const log = createLog(CHANNEL);

/**
 * Get the TikZ template from configuration or use default
 * @returns The TikZ template string
 */
function getTikzTemplate(): string {
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
 * Create a standalone LaTeX file for a TikZ picture
 * @param tikzpictures TikZ picture content
 * @param label Label for the figure
 * @param buildDir Absolute build directory path
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns FileLocation of created LaTeX file
 */
async function createStandalone(
  tikzpictures: string,
  label: string,
  buildDir: string,
  suffix?: string,
): Promise<FileLocation> {
  const standaloneContent = await renderPrompt(getTikzTemplate(), {
    tikzpicture: tikzpictures,
  });

  const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
  const texLocation = pathToLocation(path.join(buildDir, filename));

  await AbsoluteFS.write(texLocation.absolutePath, standaloneContent);
  log.debug(`Created standalone LaTeX file: ${texLocation.absolutePath}`);

  return texLocation;
}

/**
 * TikZ picture extraction and compilation, exported as a stateless module of
 * functions (no class state or lifecycle). `compile` keeps `this.extract` so
 * a `vi.spyOn(TikzPictureManager, 'extract')` still intercepts the internal
 * call, matching the previous class behavior.
 */
export const TikzPictureManager = {
  /**
   * Extract TikZ pictures with their labels from a LaTeX file
   * @param latexFile FileLocation of the LaTeX file
   * @returns Array of [label, tikzpictures] tuples
   */
  async extract(latexFile: FileLocation): Promise<[string, string[]][]> {
    const content = await AbsoluteFS.read(latexFile.absolutePath);

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
        log.debug(`Found TikZ picture with label: ${label}`);
      }
    }

    return labeledTikzPictures;
  },

  /**
   * Extract and compile TikZ pictures from a LaTeX file
   * @param latexFile Location of the LaTeX file
   * @returns Array of FileLocations for compiled PDF files
   */
  async compile(latexFile: FileLocation): Promise<FileLocation[]> {
    const inputName = path.parse(latexFile.absolutePath).name;
    const buildDir = path.join(
      path.dirname(latexFile.absolutePath),
      'build',
      inputName,
    );

    await AbsoluteFS.ensureDir(buildDir);

    log.debug(`Extracting TikZ pictures from ${latexFile.absolutePath}`);
    const labeledTikzPictures = await this.extract(latexFile);
    log.debug(`Found ${labeledTikzPictures.length} labeled TikZ pictures`);

    const compiledFiles: FileLocation[] = [];

    for (const [label, tikzPictures] of labeledTikzPictures) {
      const hasMultiple = tikzPictures.length > 1;

      for (const [i, tikzpictures] of tikzPictures.entries()) {
        // Disambiguate multiple pictures under one label with a/b/c… suffixes.
        const suffix = hasMultiple ? String.fromCharCode(97 + i) : undefined;

        const texLocation = await createStandalone(
          tikzpictures,
          label,
          buildDir,
          suffix,
        );
        const compiled = await compileLatex2Pdf(texLocation, {
          channel: CHANNEL,
          compiler: 'pdflatex',
        });
        if (!compiled.ok) {
          log.warn(
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
        const pdfLocation = pathToLocation(
          texLocation.absolutePath.replace(/\.tex$/, '.pdf'),
        );

        if (await AbsoluteFS.exists(pdfLocation.absolutePath)) {
          compiledFiles.push(pdfLocation);
          log.debug(`Successfully compiled: ${pdfLocation.absolutePath}`);
        }
      }
    }

    return compiledFiles;
  },
};
