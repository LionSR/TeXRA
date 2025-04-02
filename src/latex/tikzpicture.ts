// Standard library imports
import * as path from 'path';

// Third-party imports
import * as nunjucks from 'nunjucks';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  readFile,
  fileExists,
  writeFile,
  createDirectory,
} from '../utils/workspaceFileUtils';
import { renderPrompt } from '../utils/promptUtils';
import { getConfig } from '../utils/configUtils';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Configure nunjucks
nunjucks.configure({ autoescape: false });

/**
 * Get the TikZ template from configuration or use default
 * @returns The TikZ template string
 */
function getTikzTemplate(): string {
  return getConfig<string>(
    'latex.tikzTemplate',
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
 * @param latexFile Path to the LaTeX file
 * @param channel Optional channel for logging
 * @returns Array of [label, tikzpictures] tuples
 */
export async function extractTikzPicturesWithLabels(
  latexFile: string,
  channel: string = CHANNEL,
): Promise<[string, string[]][]> {
  try {
    const content = await readFile(latexFile);

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
      `Error extracting TikZ pictures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param tikzpictures TikZ picture content
 * @param label Label for the figure
 * @param buildDir Build directory path
 * @param suffix Optional suffix for multiple pictures with same label
 * @param channel Optional channel for logging
 * @returns Path to created LaTeX file
 */
export async function createStandaloneLatexWithLabels(
  tikzpictures: string,
  label: string,
  buildDir: string,
  suffix?: string,
  channel: string = CHANNEL,
): Promise<string> {
  try {
    // Use renderPrompt instead of nunjucks directly
    const standaloneContent = await renderPrompt(getTikzTemplate(), {
      tikzpicture: tikzpictures,
    });

    // Create filename
    const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
    const filePath = path.join(buildDir, filename);

    // Write file
    await writeFile(filePath, standaloneContent);
    logger.debug(channel, `Created standalone LaTeX file: ${filePath}`);

    return filePath;
  } catch (err) {
    logger.error(
      channel,
      `Error creating standalone LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Extract and compile TikZ pictures from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @param channel Optional channel for logging
 * @returns Array of paths to compiled PDF files
 */
export async function extractAndCompileTikzPicturesWithLabels(
  latexFile: string,
  channel: string = CHANNEL,
): Promise<string[]> {
  try {
    // Setup build directory
    const inputDir = path.dirname(latexFile);
    const inputName = path.parse(path.basename(latexFile)).name;
    const buildDir = path.join(inputDir, 'build', inputName);
    await createDirectory(buildDir);

    logger.debug(channel, `Extracting TikZ pictures from ${latexFile}`);
    const labeledTikzPictures = await extractTikzPicturesWithLabels(
      latexFile,
      channel,
    );
    logger.debug(
      channel,
      `Found ${labeledTikzPictures.length} labeled TikZ pictures`,
    );

    const compiledFiles: string[] = [];

    for (const [label, tikzpicturess] of labeledTikzPictures) {
      // Generate suffixes for multiple pictures with same label
      const suffixes =
        tikzpicturess.length > 1
          ? tikzpicturess.map((_, i) => String.fromCharCode(97 + i)) // a, b, c, ...
          : [undefined];

      for (let i = 0; i < tikzpicturess.length; i++) {
        const tikzpictures = tikzpicturess[i];
        const suffix = suffixes[i];

        // Create and compile standalone LaTeX file
        const texFile = await createStandaloneLatexWithLabels(
          tikzpictures,
          label,
          buildDir,
          suffix,
          channel,
        );
        await compileLatex2Pdf(texFile, channel);

        const pdfFile = texFile.replace(/\.tex$/, '.pdf');
        if (await fileExists(pdfFile)) {
          compiledFiles.push(pdfFile);
          logger.debug(channel, `Successfully compiled: ${pdfFile}`);
        }
      }
    }

    return compiledFiles;
  } catch (err) {
    logger.error(
      channel,
      `Error extracting and compiling TikZ pictures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
