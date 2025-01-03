import * as path from 'path';
import { debug, error, initializeLogging } from '../logger/logUtils';
import {
  readFile,
  fileExists,
  getWorkspacePath,
  writeFile,
  createDirectory,
} from '../utils/fileUtils';
import { compileLatexToPdf } from './texTools';
import * as nunjucks from 'nunjucks';
import { renderPrompt } from '../utils/promptUtils';

const CHANNEL = 'LaTeX';
initializeLogging(CHANNEL);

// Configure nunjucks
nunjucks.configure({ autoescape: false });

// Add the TikZ template
// maybe in the future move to a separate file explorer.path
const TIKZ_TEMPLATE = `
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
`;

/**
 * Extract TikZ pictures with their labels from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of [label, tikzpictures] tuples
 */
export async function extractTikzPicturesWithLabels(
  latexFile: string,
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
        debug(CHANNEL, `Found TikZ picture with label: ${label}`);
      }
    }

    return labeledTikzPictures;
  } catch (err) {
    error(
      CHANNEL,
      `Error extracting TikZ pictures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param tikzPicture TikZ picture content
 * @param label Label for the figure
 * @param buildDir Build directory path
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns Path to created LaTeX file
 */
export async function createStandaloneLatexWithLabels(
  tikzPicture: string,
  label: string,
  buildDir: string,
  suffix?: string,
): Promise<string> {
  try {
    // Use renderPrompt instead of nunjucks directly
    const standaloneContent = await renderPrompt(TIKZ_TEMPLATE, {
      tikzpicture: tikzPicture,
    });

    // Create filename
    const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
    const filePath = path.join(buildDir, filename);

    // Write file
    await writeFile(filePath, standaloneContent);
    debug(CHANNEL, `Created standalone LaTeX file: ${filePath}`);

    return filePath;
  } catch (err) {
    error(
      CHANNEL,
      `Error creating standalone LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Extract and compile TikZ pictures from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of paths to compiled PDF files
 */
export async function extractAndCompileTikzPicturesWithLabels(
  latexFile: string,
): Promise<string[]> {
  try {
    // Setup build directory
    const inputDir = path.dirname(latexFile);
    const inputName = path.parse(path.basename(latexFile)).name;
    const buildDir = path.join(inputDir, 'build', inputName);
    await createDirectory(buildDir);

    debug(CHANNEL, `Extracting TikZ pictures from ${latexFile}`);
    const labeledTikzPictures = await extractTikzPicturesWithLabels(latexFile);
    debug(CHANNEL, `Found ${labeledTikzPictures.length} labeled TikZ pictures`);

    const compiledFiles: string[] = [];

    for (const [label, tikzPictures] of labeledTikzPictures) {
      // Generate suffixes for multiple pictures with same label
      const suffixes =
        tikzPictures.length > 1
          ? tikzPictures.map((_, i) => String.fromCharCode(97 + i)) // a, b, c, ...
          : [undefined];

      for (let i = 0; i < tikzPictures.length; i++) {
        const tikzPicture = tikzPictures[i];
        const suffix = suffixes[i];

        // Create and compile standalone LaTeX file
        const texFile = await createStandaloneLatexWithLabels(
          tikzPicture,
          label,
          buildDir,
          suffix,
        );
        await compileLatexToPdf(texFile);

        const pdfFile = texFile.replace(/\.tex$/, '.pdf');
        if (await fileExists(pdfFile)) {
          compiledFiles.push(pdfFile);
          debug(CHANNEL, `Successfully compiled: ${pdfFile}`);
        }
      }
    }

    return compiledFiles;
  } catch (err) {
    error(
      CHANNEL,
      `Error extracting and compiling TikZ pictures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
