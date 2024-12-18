import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from './utils/commonUtils';
import { getWorkspacePath } from './utils/fileUtils';
import * as cp from 'child_process';
import { promisify } from 'util';
import {
  deleteFile,
  moveFile,
  copyFile,
  findFile,
  createDirectory,
  readDirectory,
  fileExists,
} from './utils/fileUtils';
import { debug, info, warn, error, initializeLogging } from './utils/logUtils';
const execAsync = promisify(cp.exec);

const CHANNEL = 'Housekeeping';
initializeLogging(CHANNEL);

const EXCLUDED_DIRS = new Set([
  'figs',
  'figures',
  'build',
  'versions',
  'history',
  'notes',
  'diffs',
]);
const PACK_EXTENSIONS = ['.pdf', '.tex', '.txt', '.text', '.xml', '.md'];
const TEMP_EXTENSIONS = [
  '.pdf',
  '.aux',
  '.bbl',
  '.blg',
  '.fdb_latexmk',
  '.fls',
  '.log',
  '.out',
  '.synctex.gz',
  '.bib',
  '.nav',
  '.run.xml',
  '.snm',
  '.toc',
  '-blx.bib',
  'Notes.bib',
];
const MODELS = [
  'opus',
  'sonnet',
  'sonnet+',
  'sonnet++',
  'haiku+',
  'haiku',
  'o1',
  'o1preview',
  'o1-',
  'gpt4ol',
  'gpt4o',
  'gpt4o-',
  'gpt4t',
  'geminiexp',
  'gemini2p',
  'gemini2f',
  'gemini1p+',
  'gemini1f+',
  'gemini1p+OR',
  'gemini1f+OR',
  'llama3+OR',
];
const HISTORY_DIR = 'History';

function getAgentFirstNameChunk(agent: string): string {
  debug(CHANNEL, `Getting agent first name chunk for: ${agent}`);
  let result: string;
  if (agent.startsWith('write-')) {
    result = agent.split('-')[1];
  } else {
    result = agent.includes('_') ? agent.split('_')[0] : agent.split('-')[0];
  }
  debug(CHANNEL, `Agent first name chunk resolved to: ${result}`);
  return result;
}

function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);

  for (let round = 0; round < numRounds; round++) {
    patterns.push(
      `${base}_${agentFirstNameChunk}_r${round}_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_diffr${round}r${round - 1}`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diffr${round}r${round - 1}`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_thinking`,
    );
  }
  return patterns;
}

export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<void> {
  info(
    CHANNEL,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  if (!inputFile || !model || !agent) {
    error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for clean single',
    );
    return;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = getFilePatterns(baseName, model, agentFirstNameChunk);
  debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  debug(CHANNEL, `Using extensions: ${extensions}`);

  let filesFound = false;
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found file to delete: ${filePath}`);
        filesFound = true;
        await deleteFile(filePath);
      }

      const buildFilePath = await findFile(
        path.join(inputDir, 'build'),
        pattern,
        ext,
      );
      if (buildFilePath) {
        debug(CHANNEL, `Found build file to delete: ${buildFilePath}`);
        filesFound = true;
        await deleteFile(buildFilePath);
      }
    }
  }

  if (!filesFound) {
    warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to clean for ${inputFile}`,
    );
  } else {
    info(CHANNEL, `Cleanup complete for ${inputFile}`);
    vscode.window.showInformationMessage(`Cleanup complete for ${inputFile}`);
  }
}

export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<string> {
  info(
    CHANNEL,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  );

  if (!inputFile || !model || !agent) {
    error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for pack single',
    );
    return '';
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentFirstNameChunk),
    baseName,
  ];
  debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];

  // Find files to move or copy
  for (const pattern of filePatterns) {
    for (const ext of PACK_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found file: ${filePath}`);
        if (filePath === inputFile || pattern === baseName) {
          copiedFiles.push(filePath);
        } else {
          movedFiles.push(filePath);
        }
      }
    }
  }

  debug(CHANNEL, `Files to move: ${movedFiles}`);
  debug(CHANNEL, `Files to copy: ${copiedFiles}`);

  if (movedFiles.length > 0 || copiedFiles.length > 0) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    outputFolder =
      outputFolder ||
      path.join(inputDir, HISTORY_DIR, `${now}_${baseName}_${agent}_${model}`);
    debug(CHANNEL, `Output folder: ${outputFolder}`);

    try {
      // Use the new helper function
      await createDirectory(outputFolder);
      debug(CHANNEL, `Created output directory: ${outputFolder}`);

      // Move and copy files
      for (const file of movedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        debug(CHANNEL, `Moving file from ${file} to ${destination}`);
        await moveFile(file, destination);
      }
      for (const file of copiedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        debug(CHANNEL, `Copying file from ${file} to ${destination}`);
        await copyFile(file, destination);
      }

      info(CHANNEL, `Files packed into ${outputFolder}`);
      vscode.window.showInformationMessage(`Files packed into ${outputFolder}`);
    } catch (err) {
      error(
        CHANNEL,
        `Error during file operations: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(`Error during packing: ${err}`);
      return '';
    }
  } else {
    warn(CHANNEL, `No files found to pack for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to pack for ${inputFile}`,
    );
  }

  // Clean up temporary files
  for (const pattern of filePatterns) {
    for (const ext of TEMP_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath && filePath !== inputFile) {
        await deleteFile(filePath);
      }
    }
  }

  return outputFolder || '';
}

export async function runCleanMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<void> {
  debug(
    CHANNEL,
    `Starting multiple cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  await runCleanSingle(model, inputFile, agent);

  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      await runCleanSingle(model, file, agent);
    }
  }

  info(CHANNEL, 'Cleanup complete for multiple files.');
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
  outputNameOverride?: string,
): Promise<string> {
  debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputNameOverride=${outputNameOverride}`,
  );
  debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  let baseName: string;
  let outputDir: string;

  if (outputNameOverride) {
    baseName = path.parse(outputNameOverride).name;
    outputDir = path.dirname(outputNameOverride);
  } else {
    baseName = path.parse(inputFile).name;
    outputDir = path.dirname(inputFile);
  }

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const commonOutputFolder =
    outputNameOverride ||
    path.join(
      outputDir,
      HISTORY_DIR,
      `${now}_${baseName}_multiple_${agent}_${model}`,
    );
  debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    await createDirectory(commonOutputFolder);
    debug(CHANNEL, `Created output directory: ${commonOutputFolder}`);

    // Pack the main input file
    await runPackSingle(model, inputFile, agent, commonOutputFolder);

    // Pack additional files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        debug(CHANNEL, `Packing input file: ${file}`);
        await runPackSingle(model, file, agent, commonOutputFolder);
      }
    }

    // Pack additional XML files
    const agentFirstNameChunk = getAgentFirstNameChunk(agent);
    const additionalPatterns = [
      `${baseName}_${agentFirstNameChunk}_r0_${model}.xml`,
      `${baseName}_${agentFirstNameChunk}_r1_${model}.xml`,
    ];

    for (const pattern of additionalPatterns) {
      const filePath = path.join(outputDir, pattern);
      if (await fileExists(filePath)) {
        debug(CHANNEL, `Found additional XML file: ${filePath}`);
        await moveFile(filePath, path.join(commonOutputFolder, pattern));
      }
    }

    info(CHANNEL, `All files packed into ${commonOutputFolder}`);
    return commonOutputFolder;
  } catch (err) {
    error(
      CHANNEL,
      `Error during multiple pack operation: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runCleanBuild(): Promise<void> {
  debug(CHANNEL, 'Starting build directory cleanup');

  async function cleanBuildDir(directory: string) {
    const buildDir = path.join(directory, 'build');
    if (await fileExists(buildDir)) {
      try {
        const entries = await readDirectory(buildDir);
        for (const [name, type] of entries) {
          if (type === vscode.FileType.File) {
            const filePath = path.join(buildDir, name);
            await deleteFile(filePath);
          }
        }
        debug(CHANNEL, `Cleaned build directory: ${buildDir}`);
      } catch (err) {
        error(
          CHANNEL,
          `Error cleaning build directory ${buildDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async function processDirectory(dirPath: string) {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        // here one should include the build directory
        if (
          type === vscode.FileType.Directory &&
          !EXCLUDED_DIRS.has(name.toLowerCase())
        ) {
          const fullPath = path.join(dirPath, name);
          await cleanBuildDir(fullPath);
          await processDirectory(fullPath);
        }
      }
    } catch (err) {
      error(
        CHANNEL,
        `Error processing directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    await processDirectory('.');
    info(CHANNEL, 'Build directories cleaned');
  } catch (err) {
    error(
      CHANNEL,
      `Error cleaning build directories: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runCleanOutput(): Promise<void> {
  debug(CHANNEL, 'Starting output directory cleanup');
  const filesToDelete = new Set<string>();
  const validExtensions = new Set(['.tex', '.pdf', '.xml']);

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }

        if (type === vscode.FileType.Directory) {
          await processDirectory(path.join(dirPath, name));
        } else if (type === vscode.FileType.File) {
          const ext = path.extname(name);
          if (validExtensions.has(ext)) {
            // Check if file matches any model pattern
            if (MODELS.some((model) => name.includes(`_${model}`))) {
              filesToDelete.add(path.join(dirPath, name));
            }
          }
        }
      }
    } catch (err) {
      error(
        CHANNEL,
        `Error processing directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  await processDirectory('.');

  for (const file of filesToDelete) {
    await deleteFile(file);
  }

  info(CHANNEL, 'All AI Generated Output files cleaned');
}

export async function runPackLatexDiffVC(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting LaTeX diff packing with inputFile=${inputFile}, commitHash=${commitHash}, clean=${clean}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToProcess: string[] = [];
  const filesToDelete: string[] = [];

  // Find files to process
  for (const pattern of filePatterns) {
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found file to process: ${filePath}`);
        filesToProcess.push(filePath);

        // Find associated temporary files
        for (const tempExt of TEMP_EXTENSIONS) {
          const tempFile = path.join(
            path.dirname(filePath),
            `${pattern}${tempExt}`,
          );
          if (await fileExists(tempFile)) {
            debug(CHANNEL, `Found temporary file: ${tempFile}`);
            filesToDelete.push(tempFile);
          }
        }
      }
    }
  }

  if (filesToProcess.length > 0) {
    if (clean) {
      // Delete all files if clean mode
      for (const file of [...filesToProcess, ...filesToDelete]) {
        await deleteFile(file);
      }
      info(CHANNEL, 'Cleanup complete.');
      vscode.window.showInformationMessage('LaTeX diff files cleaned');
    } else {
      // Move files to output folder
      const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
      const outputFolder = path.join(
        inputDir,
        'Diffs',
        `${now}_${baseName}_${commitHash}`,
      );

      try {
        await createDirectory(outputFolder);
        debug(CHANNEL, `Created output directory: ${outputFolder}`);

        // Move main files
        for (const file of filesToProcess) {
          await moveFile(file, path.join(outputFolder, path.basename(file)));
        }

        // Delete temporary files
        for (const file of filesToDelete) {
          await deleteFile(file);
        }

        info(CHANNEL, `Files packed into ${outputFolder}`);
      } catch (err) {
        error(
          CHANNEL,
          `Error during packing: ${err instanceof Error ? err.message : String(err)}`,
        );
        vscode.window.showErrorMessage(`Error during packing: ${err}`);
      }
    }
  } else {
    warn(CHANNEL, 'No files found to process.');
    vscode.window.showInformationMessage(
      'No LaTeX diff files found to process',
    );
  }
}

export async function runPackLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting multiple LaTeX diff packing with commitHash=${commitHash}, clean=${clean}`,
  );
  debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    debug(CHANNEL, `Processing file: ${inputFile}`);
    await runPackLatexDiffVC(inputFile, commitHash, clean);
  }

  info(CHANNEL, 'Multiple LaTeX diff files processed');
}

export async function runCleanLatexDiffVC(
  inputFile: string,
  commitHash: string,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting LaTeX diff cleaning with inputFile=${inputFile}, commitHash=${commitHash}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToDelete: string[] = [];

  // Find files to delete
  for (const pattern of filePatterns) {
    // Find main files (.tex and .pdf)
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found main file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }

    // Find all temporary files
    for (const tempExt of TEMP_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, tempExt);
      if (filePath) {
        debug(CHANNEL, `Found temporary file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }

      // Also check in build directory
      const buildFilePath = await findFile(
        path.join(inputDir, 'build'),
        pattern,
        tempExt,
      );
      if (buildFilePath) {
        debug(CHANNEL, `Found build file to delete: ${buildFilePath}`);
        filesToDelete.push(buildFilePath);
      }
    }
  }

  if (filesToDelete.length > 0) {
    // Delete all found files
    for (const file of filesToDelete) {
      await deleteFile(file);
    }
    info(CHANNEL, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeX diff files cleaned');
  } else {
    warn(CHANNEL, 'No files found to clean.');
    vscode.window.showInformationMessage('No LaTeX diff files found to clean');
  }
}

export async function runCleanLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting multiple LaTeX diff cleaning with commitHash=${commitHash}`,
  );
  debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff cleaning',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    debug(CHANNEL, `Processing file: ${inputFile}`);
    await runCleanLatexDiffVC(inputFile, commitHash);
  }

  info(CHANNEL, 'Multiple LaTeX diff files cleaned');
}

export async function runIndentTex(): Promise<void> {
  debug(CHANNEL, 'Starting LaTeX indentation process');

  const config = getConfig<string>('latex.latexindentConfig', '');
  debug(CHANNEL, `LaTeX indent config: ${config}`);

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    error(CHANNEL, 'No workspace path found');
    vscode.window.showErrorMessage('No workspace path found');
    return;
  }

  if (config) {
    // Check if config file exists - use fs.access directly since this is an absolute path
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(config));
    } catch (err) {
      error(CHANNEL, `Error: Latexindent config file not found at ${config}`);
      vscode.window.showErrorMessage(
        `Latexindent config file not found at ${config}`,
      );
      return;
    }
  }

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }
        if (name.includes('Diffs')) {
          continue;
        }

        const fullPath = path.join(dirPath, name);

        if (type === vscode.FileType.Directory) {
          await processDirectory(fullPath);
        } else if (type === vscode.FileType.File && name.endsWith('.tex')) {
          debug(CHANNEL, `Processing file: ${fullPath}`);
          try {
            const command = [
              'latexindent',
              `"${fullPath}"`,
              '-w', // Write to file
              '-s', // Silent mode
              config ? `-l="${config}"` : '', // Use absolute config path directly
            ]
              .filter(Boolean)
              .join(' ');

            debug(CHANNEL, `Executing command: ${command}`);
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd: workspacePath,
              });
              if (stdout) {
                debug(CHANNEL, `Command output: ${stdout}`);
              }
              if (stderr) {
                warn(CHANNEL, `Command stderr: ${stderr}`);
              }
              info(CHANNEL, `Successfully indented: ${fullPath}`);
            } catch (execError) {
              error(CHANNEL, `Command error: ${execError}`);
              if (execError instanceof Error && 'stderr' in execError) {
                error(CHANNEL, `Command stderr: ${(execError as any).stderr}`);
              }
              continue;
            }
          } catch (err) {
            error(CHANNEL, `Error indenting file ${fullPath}: ${err}`);
            continue;
          }
        }
      }
    } catch (err) {
      error(CHANNEL, `Error processing directory ${dirPath}: ${err}`);
    }
  };

  try {
    await processDirectory('.');

    // Clean up temporary files recursively
    const processCleanup = async (dirPath: string) => {
      try {
        const entries = await readDirectory(dirPath);
        for (const [name, type] of entries) {
          if (EXCLUDED_DIRS.has(name.toLowerCase())) {
            continue;
          }
          if (name.includes('Diffs')) {
            continue;
          }

          const fullPath = path.join(dirPath, name);

          if (type === vscode.FileType.Directory) {
            await processCleanup(fullPath);
          } else if (type === vscode.FileType.File) {
            // Check for temporary files
            if (
              name.endsWith('.bak') ||
              name.endsWith('.bak0') ||
              name.endsWith('.bak1') ||
              name === 'indent.log'
            ) {
              debug(CHANNEL, `Found cleanup file: ${fullPath}`);
              await deleteFile(fullPath);
            }
          }
        }
      } catch (err) {
        error(CHANNEL, `Error during cleanup in directory ${dirPath}: ${err}`);
      }
    };

    // Start cleanup from workspace root
    await processCleanup('.');

    info(CHANNEL, 'All .tex files have been indented');
  } catch (err) {
    error(CHANNEL, `Error during indentation process: ${err}`);
    vscode.window.showErrorMessage(`Error during indentation: ${err}`);
  }
}
