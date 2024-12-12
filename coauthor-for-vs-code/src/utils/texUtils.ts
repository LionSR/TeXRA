import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import {
  getWorkspacePath,
  readFile,
  writeFile,
  deleteFile,
  fileExists,
} from './fileUtils';
import { debug, info, warn, error, initializeLogging } from './logUtils';
import { sync as globSync } from 'glob';

const execAsync = promisify(cp.exec);

const CHANNEL = 'TexUtils';
initializeLogging(CHANNEL);

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
    debug(CHANNEL, `Line breaks added to ${diffFileName}`);
  } catch (err) {
    error(
      CHANNEL,
      `Error processing diff file: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

async function processTikzpictureEndings(filePath: string): Promise<void> {
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
    debug(CHANNEL, `Tikzpicture endings fixed in ${filePath}`);
  } catch (err) {
    error(
      CHANNEL,
      `Error processing tikzpicture endings: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexDiff(
  inputFile: string,
  editedFile: string,
): Promise<string> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
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
      error(CHANNEL, 'Files missing document environment');
      vscode.window.showWarningMessage(
        'Files must contain \\begin{document} and \\end{document}',
      );
      throw new Error('Files missing document environment');
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
      diffFileName = `${path.parse(editedFileName).name}_diff.tex`;
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
    ].join(' ');

    debug(CHANNEL, `Running command: ${command}`);
    const { stdout } = await execAsync(command, { cwd: workspacePath });

    // Write the output to the diff file
    await writeFile(outputPath, stdout);

    await processDiffFile(outputPath);
    await processTikzpictureEndings(outputPath);

    info(CHANNEL, 'LaTeX diff completed successfully');
    return diffFileName;
  } catch (err) {
    error(
      CHANNEL,
      `Error running LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexDiffVC(
  inputFile: string,
  commitHash: string,
): Promise<string> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Use readFile which now handles workspace paths
    const inputContent = await readFile(inputFile);

    if (
      !inputContent.includes('\\begin{document}') ||
      !inputContent.includes('\\end{document}')
    ) {
      error(CHANNEL, 'File missing document environment');
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
    ].join(' ');

    debug(CHANNEL, `Running command: ${command}`);
    await execAsync(command, { cwd: workspacePath }); // Execute from workspace root

    await processDiffFile(outputPath);
    await processTikzpictureEndings(outputPath);

    info(CHANNEL, 'LaTeX diff VC completed successfully');
    return path.basename(diffFileName);
  } catch (err) {
    error(
      CHANNEL,
      `Error running LaTeX diff VC: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  debug(CHANNEL, `Processing multiple files with commit ${commitHash}`);

  if (!inputFiles || inputFiles.length === 0) {
    error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage('No input files provided');
    return;
  }

  for (const inputFile of inputFiles) {
    try {
      await runLatexDiffVC(inputFile, commitHash);
    } catch (err) {
      error(
        CHANNEL,
        `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  info(CHANNEL, 'All LaTeX diff operations completed');
}

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Get latexindent config from settings
    const config = vscode.workspace.getConfiguration('coauthor.latex');
    const latexindentConfig = config.get<string>('latexindentConfig');

    // Build command array - note we're using -w (overwrite) and -s (silent)
    const command = ['latexindent', '-w', '-s'];
    if (latexindentConfig) {
      command.push(`-l=${latexindentConfig}`);
    }
    command.push(`"${filePath}"`);

    debug(CHANNEL, `Running command: ${command.join(' ')}`);

    // Execute latexindent from workspace root
    const { stdout, stderr } = await execAsync(command.join(' '), {
      cwd: workspacePath,
    });

    if (stderr && stderr.trim()) {
      warn(CHANNEL, `Latexindent stderr: ${stderr}`);
    }

    // Wait a moment for the file system to stabilize
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);

    // Get all backup files matching the patterns, relative to workspace
    const backupPatterns = [
      path.join(fileDir, `${fileBaseName}.tex.bak*`),
      path.join(fileDir, `${fileBaseName}.tex.bak`),
      path.join(fileDir, `${fileBaseName}.bak*`),
      path.join(fileDir, `${fileBaseName}.bak`),
    ];

    // Clean up backup files from workspace directory
    for (const pattern of backupPatterns) {
      const backupFiles = globSync(pattern, {
        cwd: workspacePath,
        absolute: false,
      });

      for (const backupFile of backupFiles) {
        try {
          await deleteFile(backupFile);
          debug(CHANNEL, `Removed backup file: ${backupFile}`);
        } catch (err) {
          warn(CHANNEL, `Error removing backup file ${backupFile}: ${err}`);
        }
      }
    }

    // Clean up indent.log
    const indentLogPath = path.join(path.dirname(filePath), 'indent.log');
    try {
      await deleteFile(indentLogPath);
      debug(CHANNEL, 'Removed indent.log');
    } catch (err) {
      // Ignore error if indent.log doesn't exist
      warn(CHANNEL, `Error removing indent.log: ${err}`);
    }

    info(CHANNEL, `Indented ${filePath}`);
    return true;
  } catch (err) {
    error(
      CHANNEL,
      `Error running LaTeX indent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Compile a LaTeX file to PDF
 * @param texFile Path to the LaTeX file
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatexToPdf(texFile: string): Promise<boolean> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const outputDirectory = path.dirname(texFile);
    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${texFile}"`,
    ].join(' ');

    debug(CHANNEL, `Running command: ${command}`);
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspacePath,
    });

    if (stderr && stderr.trim()) {
      warn(CHANNEL, `pdflatex stderr: ${stderr}`);
    }

    info(CHANNEL, `Successfully compiled ${texFile}`);
    return true;
  } catch (err) {
    error(
      CHANNEL,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Get full statistics for LaTeX documents using the texcount Perl script
 * @param filePaths Single file path or array of file paths
 * @param merge Whether to merge included files in the count
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export async function getTexCount(
  filePaths: string | string[],
  merge: boolean = false,
): Promise<string | null> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Convert single path to array
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const allOutputs: string[] = [];

    for (const filePath of paths) {
      if (!(await fileExists(filePath))) {
        warn(CHANNEL, `Warning: File ${filePath} does not exist.`);
        continue;
      }

      if (!filePath.endsWith('.tex')) {
        warn(CHANNEL, `Error: File ${filePath} is not a LaTeX file. Skipping.`);
        continue;
      }

      const command = ['texcount'];
      if (merge) {
        command.push('-merge');
      }
      command.push(`"${filePath}"`);

      debug(CHANNEL, `Running command: ${command.join(' ')}`);
      try {
        const { stdout, stderr } = await execAsync(command.join(' '), {
          cwd: workspacePath,
        });

        if (stderr && stderr.trim()) {
          warn(CHANNEL, `texcount stderr: ${stderr}`);
        }

        allOutputs.push(`Tex Count Results for ${filePath}:\n${stdout}`);
        debug(CHANNEL, `Successfully counted ${filePath}`);
      } catch (err) {
        error(CHANNEL, `Error getting tex count for ${filePath}`);
        error(
          CHANNEL,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (allOutputs.length > 0) {
      const combinedOutput = allOutputs.join('\n\n');
      info(CHANNEL, `Combined Tex Count Results:\n${combinedOutput}`);
      return combinedOutput;
    }

    return null;
  } catch (err) {
    error(
      CHANNEL,
      `Error in getTexCount: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
