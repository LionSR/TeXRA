import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import { getWorkspacePath } from './commonUtils';
import { debug, info, warn, error, initializeLogging } from './logUtils';
import * as glob from 'glob';

const execAsync = promisify(cp.exec);

const CHANNEL = 'TexUtils';
initializeLogging(CHANNEL);

export async function processFile(filePath: string): Promise<string> {
  const uri = vscode.Uri.file(filePath);
  const content = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(content).toString('utf-8');
}

async function writeFile(filePath: string, content: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

async function processDiffFile(diffFileName: string): Promise<void> {
  try {
    const content = await processFile(diffFileName);
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
    const content = await processFile(filePath);

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

    // Convert relative paths to absolute paths
    const fullInputPath = path.join(workspacePath, inputFile);
    const fullEditedPath = path.join(workspacePath, editedFile);

    // Check if files contain required commands
    const inputContent = await processFile(fullInputPath);
    const editedContent = await processFile(fullEditedPath);

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

    const outputPath = path.join(
      workspacePath,
      path.dirname(inputFile),
      diffFileName,
    );

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

    // Convert relative path to absolute path
    const fullInputPath = path.join(workspacePath, inputFile);

    // Check if file contains required commands
    const inputContent = await processFile(fullInputPath);
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
      workspacePath,
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

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);
    
    // Get all backup files matching the patterns, relative to workspace
    const backupPatterns = [
      path.join(fileDir, `${fileBaseName}.tex.bak*`),
      path.join(fileDir, `${fileBaseName}.tex.bak`),
      path.join(fileDir, `${fileBaseName}.bak*`),
      path.join(fileDir, `${fileBaseName}.bak`)
    ];

    // Clean up backup files from workspace directory
    for (const pattern of backupPatterns) {
      const backupFiles = glob.sync(pattern, { 
        cwd: workspacePath,
        absolute: false 
      });
      
      for (const backupFile of backupFiles) {
        try {
          const backupUri = vscode.Uri.file(path.join(workspacePath, backupFile));
          await vscode.workspace.fs.delete(backupUri);
          debug(CHANNEL, `Removed backup file: ${backupFile}`);
        } catch (err) {
          if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
            warn(CHANNEL, `Error removing backup file ${backupFile}: ${err}`);
          }
        }
      }
    }

    // Clean up indent.log relative to workspace
    const indentLogPath = path.join(fileDir, 'indent.log');
    try {
      const logUri = vscode.Uri.file(path.join(workspacePath, indentLogPath));
      if (await vscode.workspace.fs.stat(logUri)) {
        await vscode.workspace.fs.delete(logUri);
        debug(CHANNEL, 'Removed indent.log');
      }
    } catch (err) {
      // Ignore error if indent.log doesn't exist
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        warn(CHANNEL, `Error removing indent.log: ${err}`);
      }
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
