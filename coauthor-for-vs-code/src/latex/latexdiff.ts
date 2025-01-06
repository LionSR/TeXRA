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

const CHANNEL = 'LaTeX';
logger.initialize(CHANNEL);

async function processDiffFile(diffFileName: string): Promise<void> {
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
    logger.debug(CHANNEL, `Line breaks added to ${diffFileName}`);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error processing diff file: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

async function processTikzPictureEndings(filePath: string): Promise<void> {
  try {
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
    logger.debug(CHANNEL, `Tikzpicture endings fixed in ${filePath}`);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error processing tikzpicture endings: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexdiff(
  inputFile: string,
  editedFile: string,
  suffix: string = '_diff',
  runIndent: boolean = false,
): Promise<string | undefined> {
  try {
    if (!inputFile) {
      logger.warn(CHANNEL, 'Input file is empty or undefined');
      return undefined;
    }

    // Check if both files exist
    if (!(await fileExists(inputFile)) || !(await fileExists(editedFile))) {
      logger.warn(
        CHANNEL,
        `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`,
      );
      return undefined;
    }

    if (runIndent) {
      // Import and run latexindent if needed
      if (
        !(await runLatexIndent(inputFile)) ||
        !(await runLatexIndent(editedFile))
      ) {
        logger.warn(
          CHANNEL,
          'Failed to indent one or both files. Proceeding with latexdiff anyway.',
        );
      }
    }

    // Files are now relative to workspace, no need for extra path joining
    const inputContent = await readFile(inputFile);
    const editedContent = await readFile(editedFile);

    if (
      !inputContent.includes('\\begin{document}') ||
      !inputContent.includes('\\end{document}') ||
      !editedContent.includes('\\begin{document}') ||
      !editedContent.includes('\\end{document}')
    ) {
      logger.warn(
        CHANNEL,
        'One or both files do not contain \\begin{document} and \\end{document}. Skipping latexdiff.',
      );
      logger.warn(
        CHANNEL,
        `Input file: ${inputFile}, Output file: ${editedFile}`,
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

    const result = await executeCommand(command, { channel: CHANNEL });
    if (!result.success || !result.stdout) {
      throw new Error('Failed to run latexdiff');
    }

    // Write the output to the diff file
    await writeFile(outputPath, result.stdout);

    await processDiffFile(outputPath);
    await processTikzPictureEndings(outputPath);

    logger.info(CHANNEL, 'LaTeX diff completed successfully');
    return diffFileName;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error running LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexdiffvc(
  inputFile: string,
  commitHash: string,
): Promise<string> {
  try {
    // Use readFile which now handles workspace paths
    const inputContent = await readFile(inputFile);

    if (
      !inputContent.includes('\\begin{document}') ||
      !inputContent.includes('\\end{document}')
    ) {
      logger.error(CHANNEL, 'File missing document environment');
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

    const result = await executeCommand(command, { channel: CHANNEL });
    if (!result.success) {
      throw new Error('Failed to run latexdiff-vc');
    }

    await processDiffFile(outputPath);
    await processTikzPictureEndings(outputPath);

    logger.info(CHANNEL, 'LaTeX diff VC completed successfully');
    return path.basename(diffFileName);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error running LaTeX diff VC: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  logger.debug(CHANNEL, `Processing multiple files with commit ${commitHash}`);

  if (!inputFiles || inputFiles.length === 0) {
    logger.error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage('No input files provided');
    return;
  }

  for (const inputFile of inputFiles) {
    try {
      await runLatexdiffvc(inputFile, commitHash);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(CHANNEL, 'All LaTeX diff operations completed');
}

export async function runLatexdiffForRound(
  baseFile: string,
  outputFile: string,
  round: number,
): Promise<string | undefined> {
  try {
    if ((await fileExists(baseFile)) && (await fileExists(outputFile))) {
      return await runLatexdiff(baseFile, outputFile, '_diff');
    } else {
      logger.warn(
        CHANNEL,
        `Could not generate latexdiff for round ${round}. Files not found: ${baseFile} or ${outputFile}`,
      );
      return undefined;
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in runLatexdiffForRound: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runLatexdiffBetweenRounds(
  outputFile1: string,
  outputFile2: string,
): Promise<string | undefined> {
  try {
    if ((await fileExists(outputFile1)) && (await fileExists(outputFile2))) {
      const firstRoundMatch = outputFile1.match(/_r(\d+)_/);
      const secondRoundMatch = outputFile2.match(/_r(\d+)_/);

      if (!firstRoundMatch || !secondRoundMatch) {
        logger.warn(CHANNEL, 'Could not extract round numbers from file names');
        return undefined;
      }

      const firstRound = firstRoundMatch[1];
      const secondRound = secondRoundMatch[1];
      const diffSuffix = `_diffr${secondRound}r${firstRound}`;

      return await runLatexdiff(outputFile1, outputFile2, diffSuffix);
    } else {
      logger.warn(
        CHANNEL,
        `Could not generate latexdiff between rounds. Files not found: ${outputFile1} or ${outputFile2}`,
      );
      return undefined;
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in runLatexdiffBetweenRounds: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runLatexdiffMultiple(
  inputFiles: string[],
  editedFiles: string[],
): Promise<void> {
  try {
    if (inputFiles.length !== editedFiles.length) {
      logger.error(
        CHANNEL,
        'The number of input files must match the number of edited files. Stopping latexdiff.',
      );
      vscode.window.showErrorMessage(
        'The number of input files must match the number of edited files',
      );
      return;
    }

    for (let i = 0; i < inputFiles.length; i++) {
      try {
        await runLatexdiff(inputFiles[i], editedFiles[i]);
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error processing file pair ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    logger.info(CHANNEL, 'All LaTeX diff operations completed');
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in runLatexdiffMultiple: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
