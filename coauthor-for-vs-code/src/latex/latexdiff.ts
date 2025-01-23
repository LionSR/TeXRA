// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/fileUtils';
import { executeCommand } from '../utils/execUtils';

// Local imports - latex utils
import { runLatexIndent } from './latexindent';
import { checkToolInstalled } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Checks if latexdiff is installed and shows error if not
 */
export async function ensureLatexdiffInstalled(
  showError: boolean = true,
): Promise<boolean> {
  return checkToolInstalled('latexdiff', showError);
}

/**
 * Checks if latexdiff-vc is installed and shows error if not
 */
export async function ensureLatexdiffVcInstalled(
  showError: boolean = true,
): Promise<boolean> {
  return checkToolInstalled('latexdiff-vc', showError);
}

async function processDiffFile(
  diffFileName: string,
  channel: string = CHANNEL,
): Promise<void> {
  try {
    const content = await readFile(diffFileName);
    const lines = content.split('\n');

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
        (line.includes('%DIF ADD') || line.includes('Here is')) &&
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

    await writeFile(diffFileName, newContent);
    // logger.debug(channel, `Line breaks added to ${diffFileName}`);
  } catch (err) {
    logger.error(
      channel,
      `Error processing diff file: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

async function processTikzPictureEndings(
  filePath: string,
  channel: string = CHANNEL,
): Promise<void> {
  const content = await readFile(filePath);

  let newContent = content;
  const patterns = [
    [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
    [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
    [/\}(\s*)\\end\{tikzpicture\};/g, '};$1\\end{tikzpicture}'],
    [
      /\}(\s*)\\end\{tikzpicture\}\\DIFaddendFL ;/g,
      '$1\\end{tikzpicture}};\\DIFaddendFL',
    ],
  ];

  for (const [pattern, replacement] of patterns) {
    newContent = newContent.replace(pattern, replacement as string);
  }

  await writeFile(filePath, newContent);
  // logger.debug(channel, `Tikzpicture endings fixed in ${filePath}`);
}

export async function runLatexdiff(
  inputFile: string,
  editedFile: string,
  suffix: string = '_diff',
  runIndent: boolean = true,
  channel: string = CHANNEL,
): Promise<string | undefined> {
  try {
    if (!inputFile) {
      logger.warn(channel, 'Input file is empty or undefined');
      return undefined;
    }

    // Check if both files exist
    if (!(await fileExists(inputFile)) || !(await fileExists(editedFile))) {
      logger.warn(
        channel,
        `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`,
      );
      return undefined;
    }

    if (runIndent) {
      const indentResults = [];
      if (!(await runLatexIndent(inputFile))) indentResults.push(inputFile);
      if (!(await runLatexIndent(editedFile))) indentResults.push(editedFile);
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
      logger.warn(
        channel,
        `Files missing document environment: ${invalidFiles.join(', ')}\nSkipping latexdiff.`,
      );
      return undefined;
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

    const command = [
      'latexdiff',
      '--flatten',
      '--encoding=utf8',
      '-c',
      '"PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*"',
      `"${inputFile}"`,
      `"${editedFile}"`,
    ];

    const result = await executeCommand(command, { channel });
    if (!result.success || !result.stdout) {
      throw new Error('Failed to run latexdiff');
    }

    // Write the output to the diff file
    await writeFile(outputPath, result.stdout);

    await processDiffFile(outputPath, channel);
    await processTikzPictureEndings(outputPath, channel);

    logger.info(channel, 'LaTeXdiff completed successfully');
    return diffFileName;
  } catch (err) {
    logger.error(
      channel,
      `Error running LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexdiffvc(
  inputFile: string,
  commitHash: string,
  channel: string = CHANNEL,
): Promise<string> {
  try {
    // Use readFile which now handles workspace paths
    const inputContent = await readFile(inputFile);

    if (
      !inputContent.includes('\\begin{document}') ||
      !inputContent.includes('\\end{document}')
    ) {
      logger.error(channel, 'File missing document environment');
      vscode.window.showWarningMessage(
        'File must contain \\begin{document} and \\end{document}',
      );
      throw new Error('File missing document environment');
    }

    const diffFileName = inputFile.replace('.tex', `-diff${commitHash}.tex`);
    const outputPath = path.join(
      path.dirname(inputFile),
      path.basename(diffFileName),
    );

    const command = [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      '"PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*"',
      '--force',
      '--flatten',
      '--git',
      '-r',
      commitHash,
      `"${inputFile}"`,
    ];

    const result = await executeCommand(command, { channel });
    if (!result.success) {
      throw new Error('Failed to run latexdiff-vc');
    }

    await processDiffFile(outputPath, channel);
    await processTikzPictureEndings(outputPath, channel);

    logger.info(channel, 'LaTeXdiff VC completed successfully');
    return path.basename(diffFileName);
  } catch (err) {
    logger.error(
      channel,
      `Error running LaTeX diff VC: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  channel: string = CHANNEL,
): Promise<void> {
  logger.debug(channel, `Processing multiple files with commit ${commitHash}`);

  if (!inputFiles || inputFiles.length === 0) {
    logger.error(channel, 'No input files provided');
    vscode.window.showErrorMessage('No input files provided');
    return;
  }

  for (const inputFile of inputFiles) {
    try {
      await runLatexdiffvc(inputFile, commitHash, channel);
    } catch (err) {
      logger.error(
        channel,
        `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(channel, 'All LaTeX diff operations completed');
}

export async function runLatexdiffForRound(
  baseFile: string,
  outputFile: string,
  round: number,
  channel: string = CHANNEL,
): Promise<string | undefined> {
  try {
    if ((await fileExists(baseFile)) && (await fileExists(outputFile))) {
      return await runLatexdiff(baseFile, outputFile, '_diff', false, channel);
    } else {
      logger.warn(
        channel,
        `Could not generate latexdiff for round ${round}. Files not found: ${baseFile} or ${outputFile}`,
      );
      return undefined;
    }
  } catch (err) {
    logger.error(
      channel,
      `Error in runLatexdiffForRound: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runLatexdiffBetweenRounds(
  outputFile1: string,
  outputFile2: string,
  channel: string = CHANNEL,
): Promise<string | undefined> {
  try {
    if ((await fileExists(outputFile1)) && (await fileExists(outputFile2))) {
      const firstRoundMatch = outputFile1.match(/_r(\d+)_/);
      const secondRoundMatch = outputFile2.match(/_r(\d+)_/);

      if (!firstRoundMatch || !secondRoundMatch) {
        logger.warn(channel, 'Could not extract round numbers from file names');
        return undefined;
      }

      const firstRound = firstRoundMatch[1];
      const secondRound = secondRoundMatch[1];
      const diffSuffix = `_diffr${secondRound}r${firstRound}`;

      return await runLatexdiff(
        outputFile1,
        outputFile2,
        diffSuffix,
        false,
        channel,
      );
    } else {
      logger.warn(
        channel,
        `Could not generate latexdiff between rounds. Files not found: ${outputFile1} or ${outputFile2}`,
      );
      return undefined;
    }
  } catch (err) {
    logger.error(
      channel,
      `Error in runLatexdiffBetweenRounds: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runLatexdiffMultiple(
  inputFiles: string[],
  editedFiles: string[],
  channel: string = CHANNEL,
): Promise<void> {
  try {
    if (inputFiles.length !== editedFiles.length) {
      logger.error(
        channel,
        'The number of input files must match the number of edited files. Stopping latexdiff.',
      );
      vscode.window.showErrorMessage(
        'The number of input files must match the number of edited files',
      );
      return;
    }

    const results: { success: string[]; failed: string[] } = {
      success: [],
      failed: [],
    };

    for (let i = 0; i < inputFiles.length; i++) {
      try {
        await runLatexdiff(
          inputFiles[i],
          editedFiles[i],
          '_diff',
          false,
          channel,
        );
        results.success.push(inputFiles[i]);
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
  } catch (err) {
    logger.error(
      channel,
      `Error in runLatexdiffMultiple: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
