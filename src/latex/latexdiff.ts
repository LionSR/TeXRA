// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/workspaceFileUtils';
import { executeCommand } from '../utils/execUtils';
import { ExecResult } from '../types/ResultTypes';
import { getConfig } from '../utils/configUtils';
import { logErrorMessage } from '../utils/errorHandlingUtils';

// Local imports - latex utils
import { runLatexFormatter } from './texFormatter';

// Local imports - replacement utils
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../replacement/replacementUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Constants
const LATEXDIFF_TIMEOUT_MS = 10000;
const DEFAULT_PICTURE_ENVS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';
const DEFAULT_MATH_MARKUP = 'coarse';
// '"PICTUREENV=(?:picture|scope|DIFnomarkup)[\\w\\d*@]*"',
// '--math-markup=whole',

// Bibliography error detection patterns
const BIBLIOGRAPHY_ERROR_PATTERNS = [
  'bibtex',
  'Something went wrong in executing',
  'latex -draftmode',
  'Running bibtex to generate',
] as const;

// Error messages
const ERROR_MESSAGES = {
  TIMEOUT: (commandType: string, timeoutMs: number) =>
    `${commandType} operation timed out after ${timeoutMs}ms`,
  TIMEOUT_RETRY: (commandType: string, timeoutMs: number) =>
    `${commandType} operation timed out after ${timeoutMs}ms (retry)`,
  FAILED_BOTH: (commandType: string) =>
    `Failed to run ${commandType} (both with and without --flatten)`,
  FAILED_GENERAL: (commandType: string) => `Failed to run ${commandType}`,
} as const;

// Helper function to check if error is related to bibliography compilation
function isBibliographyError(errorOutput: string): boolean {
  return BIBLIOGRAPHY_ERROR_PATTERNS.every((pattern) =>
    errorOutput.includes(pattern),
  );
}

// Helper function to get latexdiff configuration
function getLatexdiffConfig(): { mathMarkup: string; pictureEnvs: string } {
  return {
    mathMarkup: getConfig<string>('latexdiff.mathMarkup', DEFAULT_MATH_MARKUP),
    pictureEnvs: getConfig<string>(
      'latexdiff.pictureEnvironments',
      DEFAULT_PICTURE_ENVS,
    ),
  };
}

// Helper function to build latexdiff command
function buildLatexdiffCommand(
  inputFile: string,
  editedFile: string,
  pictureEnvs: string,
  mathMarkup: string,
  useFlatten: boolean = true,
): string[] {
  const baseCommand = [
    'latexdiff',
    '--encoding=utf8',
    '-c',
    `"PICTUREENV=${pictureEnvs}"`,
    // '"MATHENV=(?:tikzpicture)"',
    `--math-markup=${mathMarkup}`,
    `"${inputFile}"`,
    `"${editedFile}"`,
  ];

  if (useFlatten) {
    baseCommand.splice(1, 0, '--flatten');
  }

  return baseCommand;
}

// Helper function to build latexdiff-vc command
function buildLatexdiffVcCommand(
  inputFile: string,
  commitHash: string,
  pictureEnvs: string,
  mathMarkup: string,
  useFlatten: boolean = true,
): string[] {
  const baseCommand = [
    'latexdiff-vc',
    '--encoding=utf8',
    '-c',
    `"PICTUREENV=${pictureEnvs}"`,
    '--force',
    '--git',
    `--math-markup=${mathMarkup}`,
    '-r',
    commitHash,
    `"${inputFile}"`,
  ];

  if (useFlatten) {
    // Insert --flatten after --force
    baseCommand.splice(5, 0, '--flatten');
  }

  return baseCommand;
}

// Helper function to execute command with fallback
async function executeWithFallback(
  commandBuilder: (useFlatten: boolean) => string[],
  commandType: string,
  channel: string,
): Promise<ExecResult> {
  // First attempt with --flatten
  logger.debug(channel, `Attempting ${commandType} with --flatten flag`);
  let result = await executeCommand(commandBuilder(true), {
    channel,
    timeout: LATEXDIFF_TIMEOUT_MS,
  });

  if (!result.success) {
    if (result.timedOut) {
      throw new Error(
        ERROR_MESSAGES.TIMEOUT(commandType, LATEXDIFF_TIMEOUT_MS),
      );
    }

    // Check if the error is related to bibliography compilation
    const errorOutput = result.stderr || '';
    if (isBibliographyError(errorOutput)) {
      logger.warn(
        channel,
        'Bibliography compilation failed with --flatten, retrying without --flatten',
      );

      // Retry without --flatten
      logger.debug(channel, `Retrying ${commandType} without --flatten flag`);
      result = await executeCommand(commandBuilder(false), {
        channel,
        timeout: LATEXDIFF_TIMEOUT_MS,
      });

      if (!result.success) {
        if (result.timedOut) {
          throw new Error(
            ERROR_MESSAGES.TIMEOUT_RETRY(commandType, LATEXDIFF_TIMEOUT_MS),
          );
        }
        throw new Error(ERROR_MESSAGES.FAILED_BOTH(commandType));
      }

      logger.info(
        channel,
        `${commandType} completed successfully (without --flatten)`,
      );
    } else {
      throw new Error(ERROR_MESSAGES.FAILED_GENERAL(commandType));
    }
  } else {
    logger.info(
      channel,
      `${commandType} completed successfully (with --flatten)`,
    );
  }

  return result;
}

// Define interfaces for the return types
export interface LaTeXdiffResult {
  success: boolean;
  diffFileName?: string;
  message?: string;
}

export interface LaTeXdiffMultipleResult {
  success: boolean;
  results: {
    success: string[];
    failed: string[];
  };
  message?: string;
}

async function processDiffFile(
  diffFileName: string,
  channel: string = CHANNEL,
): Promise<void> {
  try {
    const content = await readFile(diffFileName);

    // Process the content to remove labels from star environments
    let processedContent = content;
    const starEnvironments = [
      'align\\*',
      'equation\\*',
      'gather\\*',
      'multline\\*',
      'flalign\\*',
      'alignat\\*',
    ];

    // Create a pattern that matches any of the star environments
    const envPattern = starEnvironments.join('|');

    // This regex finds star environments and captures their content
    const starEnvRegex = new RegExp(
      `\\\\begin\\{(${envPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
      'g',
    );

    // Step 1: Remove \\label{...} from all star environments
    processedContent = processedContent.replace(
      starEnvRegex,
      (match, envName, content) => {
        // Remove \label{...} from the environment content
        const cleanContent = content.replace(/\\label\{[^}]*\}/g, '');
        return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
      },
    );

    // Now handle the rest of the processing
    const lines = processedContent.split('\n');
    let newContent = '';
    let addBlock = false;
    const packagesToAddNewline = [
      '\\usepackage{tikz}',
      '\\usepackage{pgfplots}',
      '\\providecommand{\\DIFaddbegin}',
      '\\RequirePackage[normalem]{ulem}',
      '\\usetikzlibrary',
      '\\RequirePackage{color}',
    ];

    let documentStarted = false;

    for (const line of lines) {
      if (
        line.startsWith('%!TEX root') ||
        line.startsWith('% !TEX root') ||
        line.startsWith('%! TEX root')
      ) {
        continue;
      }

      if (packagesToAddNewline.some((pkg) => line.includes(pkg))) {
        newContent += '\n';
      }

      if (line.includes('\\documentclass') || line.includes('\\input')) {
        addBlock = false;
        documentStarted = true;
      } else if (
        (line.includes('%DIF ADD') ||
          line.includes('Here is') ||
          line.includes('以下是')) &&
        !documentStarted
      ) {
        addBlock = true;
      }

      if (!addBlock) {
        newContent += line + '\n';
      }

      if (line.includes('\\RequirePackage{color}')) {
        newContent += '\n';
      }
    }

    // Apply standard replacements from the replacementUtils at the end of processing
    // First apply normal replacements
    newContent = applyReplacements(newContent, getAllReplacements()).trim();
    // Then apply regex replacements (which include LATEXDIFF_MARKUP_REPLACEMENTS)
    newContent = applyReplacements(
      newContent,
      getAllReplacementsRegex(),
    ).trim();

    await writeFile(diffFileName, newContent);
    // logger.debug(channel, `Line breaks added to ${diffFileName}`);
  } catch (err) {
    logger.error(
      channel,
      `Error processing diff file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Edge case 1: not handling well by latexdiff as it swaps }; with \end{tikzpicture} somehow
// \begin{scope}[shift={(10.5,-1.75)}]
// \node[plot] at (0,0) {
//     \begin{tikzpicture}[scale=0.7]
//         \draw[->] (-1,0) -- (1,0) node[right] {$x$};
//         \draw[->] (0,0) -- (0,1.5) node[above] {$p_{X}(x)$};
//         \draw[red, thick] plot[domain=-1:1, samples=100] (\x,{0.5*exp(-20*(\x+0.7)*(\x+0.7)) + 0.7*exp(-30*(\x+0.2)*(\x+0.2)) + 0.6*exp(-25*(\x-0.3)*(\x-0.3)) + 0.4*exp(-15*(\x-0.8)*(\x-0.8))});
//     \end{tikzpicture}
// };
// \node[below] at (0,-1) {$\bx \sim p_{X}(\bx)$};
// \end{scope}

// Edge case 2: with the rules above it screws up
// \begin{tikzpicture}[scale=0.8]
// \node[anchor=north west] at (-4,2) {
//     \begin{tabular}{l}
//         Blue: $\bet = +1$ \\
//         Red: $\bet = -1$  \\
//     \end{tabular}
// };
// \end{tikzpicture}
// Becomes
// \begin{tikzpicture}[scale=0.8]
// \node[anchor=north west] at (-4,2) {
//     \begin{tabular}{l}
//         Blue: $\bet = +1$ \\
//         Red: $\bet = -1$  \\
//     \end{tabular}
// \end{tikzpicture}\};

// So we need a middle ground.

async function processTikzPictureEndings(
  filePath: string,
  channel: string = CHANNEL,
): Promise<void> {
  const content = await readFile(filePath);

  let newContent = content;
  const patterns = [
    [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
    [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
  ];
  // the above are not for tikzpicture endings, needs to be moved elsewhere

  // Fix document boundaries first
  for (const [pattern, replacement] of patterns) {
    newContent = newContent.replace(pattern, replacement as string);
  }

  // Fix tikzpicture endings more carefully

  // Pattern 1: Fix the specific case where } is followed by \end{tikzpicture}};
  // This indicates the }; belongs to a node/scope closure, not tikzpicture
  // Example: \end{tabular} \end{tikzpicture}}; -> \end{tabular} }; \end{tikzpicture}
  // newContent = newContent.replace(
  //   /(\})(\s*)\\end\{tikzpicture\}\};/g,
  //   '$1\n        };\n    \\end{tikzpicture}',
  // );

  // // Pattern 2: Fix standalone }; before \end{tikzpicture} (edge case 1)
  // // Only match when }; is on its own line with optional whitespace
  // newContent = newContent.replace(
  //   /^(\s*)\};(\s*\n\s*)\\end\{tikzpicture\}/gm,
  //   '$1\\end{tikzpicture}\n$1};',
  // );

  // // Pattern 3: Handle cases where we have \\}; pattern
  // newContent = newContent.replace(
  //   /\\end\{tikzpicture\}(\s*)\\\};/g,
  //   '\\end{tikzpicture}$1};',
  // );

  // // Pattern 4: Fix the specific DIFaddendFL case
  // newContent = newContent.replace(
  //   /\}(\s*)\\end\{tikzpicture\}\\DIFaddendFL\s*;/g,
  //   '\\end{tikzpicture}};$1\\DIFaddendFL',
  // );

  // maybe above do more evil than correcting the issue...
  // So they are commented out for now

  await writeFile(filePath, newContent);
  // logger.debug(channel, `Tikzpicture endings fixed in ${filePath}`);
}

export async function runLatexdiff(
  inputFile: string,
  editedFile: string,
  suffix: string = '_diff',
  runIndent: boolean = true,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    if (!inputFile) {
      logger.warn(channel, 'Input file is empty or undefined');
      return { success: false, message: 'Input file is empty or undefined' };
    }

    // Check if both files exist
    if (!(await fileExists(inputFile)) || !(await fileExists(editedFile))) {
      const message = `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`;
      logger.warn(channel, message);
      return { success: false, message };
    }

    logger.info(
      channel,
      `Running latexdiff for ${inputFile} and ${editedFile}`,
    );

    if (runIndent) {
      const indentResults = [];
      if (!(await runLatexFormatter(inputFile))) {
        indentResults.push(inputFile);
      }
      if (!(await runLatexFormatter(editedFile))) {
        indentResults.push(editedFile);
      }
      if (indentResults.length > 0) {
        logger.warn(
          channel,
          `Failed to indent files:\n${indentResults.join('\n')}\nProceeding with latexdiff anyway.`,
        );
      }
    }

    // Files are now relative to workspace, no need for extra path joining
    const inputContent = await readFile(inputFile);
    const editedContent = await readFile(editedFile);

    const documentChecks = [
      { file: inputFile, content: inputContent },
      { file: editedFile, content: editedContent },
    ];

    const invalidFiles = [];
    for (const { file, content } of documentChecks) {
      if (
        !content.includes('\\begin{document}') ||
        !content.includes('\\end{document}')
      ) {
        invalidFiles.push(file);
      }
    }
    if (invalidFiles.length > 0) {
      const message = `Files missing document environment: ${invalidFiles.join(', ')}. Skipping latexdiff.`;
      logger.warn(channel, message);
      return { success: false, message };
    }

    const editedFileName = path.basename(editedFile);
    let diffFileName: string;

    // Check if both files have round numbers and possibly model names
    const inputRoundMatch = path.basename(inputFile).match(/_r(\d+)_([^.]+)/);
    const editedRoundMatch = editedFileName.match(/_r(\d+)_([^.]+)/);

    if (inputRoundMatch && editedRoundMatch) {
      // Extract round numbers and model names
      const firstRound = inputRoundMatch[1];
      const secondRound = editedRoundMatch[1];
      const firstModel = inputRoundMatch[2];
      const secondModel = editedRoundMatch[2];

      // Check if model names match
      if (firstModel === secondModel) {
        // Get the base name up to the round number (inclusive)
        const baseNameMatch = path
          .parse(editedFileName)
          .name.match(/^(.*?_r\d+)/);
        if (!baseNameMatch) {
          throw new Error('Failed to extract base name from edited file');
        }
        diffFileName = `${baseNameMatch[1]}_${secondModel}_diffr${secondRound}r${firstRound}.tex`;
      } else {
        // Models don't match, use the standard pattern
        const baseNameMatch = path
          .parse(editedFileName)
          .name.match(/^(.*?)_r\d+/);
        if (!baseNameMatch) {
          throw new Error('Failed to extract base name from edited file');
        }
        diffFileName = `${baseNameMatch[1]}_diffr${secondRound}r${firstRound}.tex`;
      }
    } else {
      // Use the default naming convention
      diffFileName = `${path.parse(editedFileName).name}${suffix}.tex`;
    }

    const outputPath = path.join(path.dirname(inputFile), diffFileName);

    // Get latexdiff configurations
    const { mathMarkup, pictureEnvs } = getLatexdiffConfig();

    // Execute latexdiff with fallback
    const result = await executeWithFallback(
      (useFlatten) =>
        buildLatexdiffCommand(
          inputFile,
          editedFile,
          pictureEnvs,
          mathMarkup,
          useFlatten,
        ),
      'latexdiff',
      channel,
    );

    if (!result.stdout) {
      throw new Error('Latexdiff produced no output');
    }

    // Write the output to the diff file
    await writeFile(outputPath, result.stdout);

    await processDiffFile(outputPath);
    await processTikzPictureEndings(outputPath);

    return {
      success: true,
      diffFileName,
      message: `LaTeXdiff completed successfully: ${diffFileName}`,
    };
  } catch (err) {
    const message = logErrorMessage(channel, 'Error running LaTeX diff', err);
    return { success: false, message };
  }
}

export async function runLatexdiffvc(
  inputFile: string,
  commitHash: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    // Use readFile which now handles workspace paths
    const inputContent = await readFile(inputFile);

    if (
      !inputContent.includes('\\begin{document}') ||
      !inputContent.includes('\\end{document}')
    ) {
      const message = 'File missing document environment';
      logger.error(channel, message);
      vscode.window.showWarningMessage(
        'File must contain \\begin{document} and \\end{document}',
      );
      return { success: false, message };
    }

    const diffFileName = inputFile.replace('.tex', `-diff${commitHash}.tex`);
    const outputPath = path.join(
      path.dirname(inputFile),
      path.basename(diffFileName),
    );

    // Get latexdiff configurations
    const { mathMarkup, pictureEnvs } = getLatexdiffConfig();

    // Execute latexdiff-vc with fallback
    const result = await executeWithFallback(
      (useFlatten) =>
        buildLatexdiffVcCommand(
          inputFile,
          commitHash,
          pictureEnvs,
          mathMarkup,
          useFlatten,
        ),
      'latexdiff-vc',
      channel,
    );

    await processDiffFile(outputPath);
    await processTikzPictureEndings(outputPath);

    return {
      success: true,
      diffFileName: path.basename(diffFileName),
      message: `LaTeXdiff VC completed successfully: ${path.basename(diffFileName)}`,
    };
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error running LaTeX diff VC',
      err,
    );
    return { success: false, message };
  }
}

export async function runLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffMultipleResult> {
  logger.debug(channel, `Processing multiple files with commit ${commitHash}`);

  if (!inputFiles || inputFiles.length === 0) {
    logger.error(channel, 'No input files provided');
    vscode.window.showErrorMessage('No input files provided');
    return {
      success: false,
      results: { success: [], failed: [] },
      message: 'No input files provided',
    };
  }

  const results: { success: string[]; failed: string[] } = {
    success: [],
    failed: [],
  };

  for (const inputFile of inputFiles) {
    try {
      const result = await runLatexdiffvc(inputFile, commitHash);
      if (result.success) {
        results.success.push(inputFile);
      } else {
        results.failed.push(inputFile);
      }
    } catch (err) {
      results.failed.push(inputFile);
      logger.error(
        channel,
        `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const summary = [
    'LaTeX diff operations completed:',
    results.success.length > 0
      ? `\nSuccessful:\n${results.success.join('\n')}`
      : '',
    results.failed.length > 0 ? `\nFailed:\n${results.failed.join('\n')}` : '',
  ].join('');

  logger.info(channel, summary);

  return {
    success: results.failed.length === 0,
    results,
    message: summary,
  };
}

export async function runLatexdiffForRound(
  baseFile: string,
  outputFile: string,
  round: number,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    if ((await fileExists(baseFile)) && (await fileExists(outputFile))) {
      return await runLatexdiff(baseFile, outputFile, '_diff', false);
    } else {
      const message = `Could not generate latexdiff for round ${round}. Files not found: ${baseFile} or ${outputFile}`;
      logger.warn(channel, message);
      return { success: false, message };
    }
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error in runLatexdiffForRound',
      err,
    );
    return { success: false, message };
  }
}

export async function runLatexdiffBetweenRounds(
  outputFile1: string,
  outputFile2: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    if ((await fileExists(outputFile1)) && (await fileExists(outputFile2))) {
      const firstRoundMatch = outputFile1.match(/_r(\d+)_/);
      const secondRoundMatch = outputFile2.match(/_r(\d+)_/);

      if (!firstRoundMatch || !secondRoundMatch) {
        const message = 'Could not extract round numbers from file names';
        logger.warn(channel, message);
        return { success: false, message };
      }

      const firstRound = firstRoundMatch[1];
      const secondRound = secondRoundMatch[1];
      const diffSuffix = `_diffr${secondRound}r${firstRound}`;

      return await runLatexdiff(outputFile1, outputFile2, diffSuffix, false);
    } else {
      const message = `Could not generate latexdiff between rounds. Files not found: ${outputFile1} or ${outputFile2}`;
      logger.warn(channel, message);
      return { success: false, message };
    }
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error in runLatexdiffBetweenRounds',
      err,
    );
    return { success: false, message };
  }
}

export async function runLatexdiffMultiple(
  inputFiles: string[],
  editedFiles: string[],
  channel: string = CHANNEL,
): Promise<LaTeXdiffMultipleResult> {
  try {
    if (inputFiles.length !== editedFiles.length) {
      const message =
        'The number of input files must match the number of edited files. Stopping latexdiff.';
      logger.error(channel, message);
      vscode.window.showErrorMessage(
        'The number of input files must match the number of edited files',
      );
      return {
        success: false,
        results: { success: [], failed: [] },
        message,
      };
    }

    const results: { success: string[]; failed: string[] } = {
      success: [],
      failed: [],
    };

    for (let i = 0; i < inputFiles.length; i++) {
      try {
        const result = await runLatexdiff(
          inputFiles[i],
          editedFiles[i],
          '_diff',
          false,
        );

        if (result.success) {
          results.success.push(inputFiles[i]);
        } else {
          results.failed.push(inputFiles[i]);
        }
      } catch (err) {
        results.failed.push(inputFiles[i]);
        logger.error(
          channel,
          `Error processing ${inputFiles[i]}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const summary = [
      'LaTeXdiff operations completed:',
      results.success.length > 0
        ? `\nSuccessful:\n${results.success.join('\n')}`
        : '',
      results.failed.length > 0
        ? `\nFailed:\n${results.failed.join('\n')}`
        : '',
    ].join('');

    logger.info(channel, summary);

    return {
      success: results.failed.length === 0,
      results,
      message: summary,
    };
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error in runLatexdiffMultiple',
      err,
    );
    return {
      success: false,
      results: { success: [], failed: [] },
      message,
    };
  }
}
