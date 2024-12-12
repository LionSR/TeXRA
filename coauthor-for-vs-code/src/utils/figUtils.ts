import * as path from 'path';
import * as fs from 'fs';
import { debug, error, initializeLogging } from './logUtils';
import {
  readFile,
  fileExists,
  getWorkspacePath,
  writeFile,
  createDirectory,
} from './fileUtils';
import { compileLatexToPdf } from './texUtils';
import * as nunjucks from 'nunjucks';

const CHANNEL = 'FigureUtils';
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
 * Extract figure paths from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of relative paths to figures
 */
export async function extractFigurePathsFromLatex(
  latexFile: string,
): Promise<string[]> {
  const figurePaths: string[] = [];

  try {
    const latexDir = path.dirname(latexFile);
    let graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

    // Regular expressions to match figure inclusion commands and graphicspath
    const figurePatterns = [
      /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
      /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
    ];
    const graphicspathPattern = /\\graphicspath\s*\{(.+?)\}/g;

    // Read file content
    const content = await readFile(latexFile);

    // Find all graphicspaths
    let graphicspathMatch;
    while ((graphicspathMatch = graphicspathPattern.exec(content)) !== null) {
      const pathStr = graphicspathMatch[1].trim();
      const paths = [pathStr.replace(/[{}]/g, '')]; // Remove braces

      for (const p of paths) {
        const normalizedPath = path.normalize(
          path.join(latexDir, p.replace(/^\/+|\/+$/g, '')),
        );
        graphicspaths.push(normalizedPath);
        debug(CHANNEL, `Added graphicspath: ${normalizedPath}`);
      }
    }

    debug(CHANNEL, `Graphicspaths: ${graphicspaths.join(', ')}`);

    // Find all matches in the content for both patterns
    for (const pattern of figurePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const figPath = match[1];
        for (const basePath of graphicspaths) {
          const normPath = path.normalize(path.join(basePath, figPath));
          // Try with common extensions if no extension is provided
          const extensions = figPath.includes('.')
            ? ['']
            : ['.pdf', '.png', '.jpg', '.jpeg'];

          for (const ext of extensions) {
            const pathToCheck = normPath + ext;
            const relPath = path.relative(latexDir, pathToCheck);
            if (await fileExists(relPath)) {
              figurePaths.push(relPath);
              debug(CHANNEL, `Found figure: ${relPath}`);
              break;
            }
          }
        }
      }
    }

    debug(CHANNEL, `Found figures: ${figurePaths.join(', ')}`);
    return figurePaths;
  } catch (err) {
    error(
      CHANNEL,
      `Error extracting figure paths: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Extract TikZ pictures with their labels from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of [label, tikzpictures] tuples
 */
export async function extractTikzpicturesWithLabels(
  latexFile: string,
): Promise<[string, string[]][]> {
  try {
    const content = await readFile(latexFile);

    // Regular expressions to match figure environments and tikzpictures
    const figurePattern =
      /\\begin{figure}.*?\\label\{(.*?)\}.*?\\end{figure}/gs;
    const tikzPattern = /\\begin{tikzpicture}.*?\\end{tikzpicture}/gs;

    const labeledTikzpictures: [string, string[]][] = [];

    let figureMatch;
    while ((figureMatch = figurePattern.exec(content)) !== null) {
      const figureContent = figureMatch[0];
      const label = figureMatch[1];

      // Find all tikzpictures in this figure
      const tikzMatches = [...figureContent.matchAll(tikzPattern)].map(
        (match) => match[0],
      );

      if (tikzMatches.length > 0) {
        labeledTikzpictures.push([label, tikzMatches]);
        debug('FigureUtils', `Found TikZ picture with label: ${label}`);
      }
    }

    return labeledTikzpictures;
  } catch (err) {
    error(
      'FigureUtils',
      `Error extracting TikZ pictures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param tikzpicture TikZ picture content
 * @param label Label for the figure
 * @param buildDir Build directory path
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns Path to created LaTeX file
 */
export async function createStandaloneLatexWithLabels(
  tikzpicture: string,
  label: string,
  buildDir: string,
  suffix?: string,
): Promise<string> {
  try {
    // Use nunjucks to render the template
    const standaloneContent = nunjucks.renderString(TIKZ_TEMPLATE, { tikzpicture });

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
export async function extractAndCompileTikzpicturesWithLabels(
  latexFile: string,
): Promise<string[]> {
  try {
    // Setup build directory
    const inputDir = path.dirname(latexFile);
    const inputName = path.parse(path.basename(latexFile)).name;
    const buildDir = path.join(inputDir, 'build', inputName);
    await createDirectory(buildDir);

    debug(CHANNEL, `Extracting TikZ pictures from ${latexFile}`);
    const labeledTikzpictures = await extractTikzpicturesWithLabels(latexFile);
    debug(CHANNEL, `Found ${labeledTikzpictures.length} labeled TikZ pictures`);

    const compiledFiles: string[] = [];

    for (const [label, tikzpictures] of labeledTikzpictures) {
      // Generate suffixes for multiple pictures with same label
      const suffixes =
        tikzpictures.length > 1
          ? tikzpictures.map((_, i) => String.fromCharCode(97 + i)) // a, b, c, ...
          : [undefined];

      for (let i = 0; i < tikzpictures.length; i++) {
        const tikzpicture = tikzpictures[i];
        const suffix = suffixes[i];

        // Create and compile standalone LaTeX file
        const texFile = await createStandaloneLatexWithLabels(
          tikzpicture,
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
