import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspacePath, getConfig } from './utils/commonUtils';
import * as cp from 'child_process';
import { promisify } from 'util';
import { deleteFile, moveFile, copyFile, findFile, createDirectory, readDirectory, fileExists} from './utils/fileUtils';
import { log, initializeLogging } from './utils/logUtils';
const execAsync = promisify(cp.exec);

const CHANNEL_NAME = 'Coauthor Housekeeping';
initializeLogging(CHANNEL_NAME);

const EXCLUDED_DIRS = new Set([
  'Figs',
  'Figures',
  'build',
  'Versions',
  'versions',
  'figs',
  'figures',
  'Notes',
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
];
const MODELS = [
  'opus',
  'sonnet',
  'sonnet+',
  'sonnet++',
  'haiku++',
  'haiku',
  'gpto1',
  'gpto1-',
  'gpt4ol',
  'gpt4t',
  'gpt4o',
  'gpt4o-',
  'gemini1p+OR',
  'gemini1f+OR',
  'llama3+OR',
];

function getAgentFirstNameChunk(agent: string): string {
  log(CHANNEL_NAME, 'Agent', `Getting agent first name chunk for: ${agent}`);
  let result: string;
  if (agent.startsWith('write-')) {
    result = agent.split('-')[1];
  } else {
    result = agent.includes('_') ? agent.split('_')[0] : agent.split('-')[0];
  }
  log(CHANNEL_NAME, 'Agent', `Agent first name chunk resolved to: ${result}`);
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
  const category = 'Clean-Single';
  log(
    CHANNEL_NAME,
    category,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  if (!inputFile || !model || !agent) {
    log(
      CHANNEL_NAME,
      category,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
      true,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for clean single',
    );
    return;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  log(
    CHANNEL_NAME,
    category,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = getFilePatterns(baseName, model, agentFirstNameChunk);
  log(CHANNEL_NAME, category, `Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  log(CHANNEL_NAME, category, `Using extensions: ${extensions}`);

  let filesFound = false;
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        log(CHANNEL_NAME, category, `Found file to delete: ${filePath}`);
        filesFound = true;
        await deleteFile(filePath);
      }

      const buildFilePath = await findFile(path.join(inputDir, 'build'), pattern, ext);
      if (buildFilePath) {
        log(CHANNEL_NAME, category, `Found build file to delete: ${buildFilePath}`);
        filesFound = true;
        await deleteFile(buildFilePath);
      }
    }
  }

  if (!filesFound) {
    log(
      CHANNEL_NAME,
      category,
      `No matching files found to clean for ${inputFile}`,
    );
    vscode.window.showInformationMessage(
      `No files found to clean for ${inputFile}`,
    );
  } else {
    vscode.window.showInformationMessage(`Cleanup complete for ${inputFile}`);
  }
}

export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<string> {
  const category = 'Pack-Single';
  log(
    CHANNEL_NAME,
    category,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  );

  if (!inputFile || !model || !agent) {
    log(
      CHANNEL_NAME,
      category,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
      true,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for pack single',
    );
    return '';
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  log(
    CHANNEL_NAME,
    category,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentFirstNameChunk),
    baseName,
  ];
  log(CHANNEL_NAME, category, `Generated patterns: ${filePatterns}`);

  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];

  // Find files to move or copy
  for (const pattern of filePatterns) {
    for (const ext of PACK_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        log(CHANNEL_NAME, category, `Found file: ${filePath}`);
        if (filePath === inputFile || pattern === baseName) {
          copiedFiles.push(filePath);
        } else {
          movedFiles.push(filePath);
        }
      }
    }
  }

  log(CHANNEL_NAME, category, `Files to move: ${movedFiles}`);
  log(CHANNEL_NAME, category, `Files to copy: ${copiedFiles}`);

  if (movedFiles.length > 0 || copiedFiles.length > 0) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    outputFolder = outputFolder || path.join(
      inputDir,
      'Versions',
      `${now}_${baseName}_${agent}_${model}`,
    );
    log(CHANNEL_NAME, category, `Output folder: ${outputFolder}`);

    try {
      // Use the new helper function
      await createDirectory(outputFolder);
      log(CHANNEL_NAME, category, `Created output directory: ${outputFolder}`);

      // Move and copy files
      for (const file of movedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        log(
          CHANNEL_NAME,
          category,
          `Moving file from ${file} to ${destination}`,
        );
        await moveFile(file, destination);
      }
      for (const file of copiedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        log(
          CHANNEL_NAME,
          category,
          `Copying file from ${file} to ${destination}`,
        );
        await copyFile(file, destination);
      }

      vscode.window.showInformationMessage(`Files packed into ${outputFolder}`);
    } catch (error) {
      log(CHANNEL_NAME, category, `Error during file operations: ${error}`, true);
      vscode.window.showErrorMessage(`Error during packing: ${error}`);
      return '';
    }
  } else {
    log(CHANNEL_NAME, category, `No files found to pack for ${inputFile}`);
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
  inputFiles: string[],
  agent: string,
): Promise<void> {
  const category = 'Clean-Multiple';
  log(
    CHANNEL_NAME,
    category,
    `Starting multiple cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  log(CHANNEL_NAME, category, `Additional files: ${inputFiles.join(', ')}`);

  await runCleanSingle(model, inputFile, agent);

  // Clean input files
  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      await runCleanSingle(model, file, agent);
    }
  }

  log(CHANNEL_NAME, category, 'Cleanup complete for multiple files.');
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  inputFiles: string[],
  agent: string,
  outputNameOverride?: string,
): Promise<string> {
  const category = 'Pack-Multiple';
  log(
    CHANNEL_NAME,
    category,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputNameOverride=${outputNameOverride}`,
  );
  log(CHANNEL_NAME, category, `Additional files: ${inputFiles.join(', ')}`);

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
  const commonOutputFolder = path.join(
    outputDir,
    'Versions',
    `${now}_${baseName}_multiple_${agent}_${model}`,
  );
  log(CHANNEL_NAME, category, `Common output folder: ${commonOutputFolder}`);

  try {
    // Use fileUtils.createDirectory instead
    await createDirectory(commonOutputFolder);
    log(CHANNEL_NAME, category, `Created output directory: ${commonOutputFolder}`);

    // Pack main input file or override file
    if (outputNameOverride) {
      await runPackSingle(model, outputNameOverride, agent, commonOutputFolder);
    } else {
      await runPackSingle(model, inputFile, agent, commonOutputFolder);
    }

    // Pack input files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        log(CHANNEL_NAME, category, `Packing input file: ${file}`);
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
      // Use fileUtils.fileExists instead
      if (await fileExists(filePath)) {
        log(CHANNEL_NAME, category, `Found additional XML file: ${filePath}`);
        await moveFile(filePath, path.join(commonOutputFolder, pattern));
      }
    }

    log(CHANNEL_NAME, category, `All files packed into ${commonOutputFolder}`);
    return commonOutputFolder;
  } catch (error) {
    log(CHANNEL_NAME, category, `Error during multiple pack operation: ${error}`, true);
    vscode.window.showErrorMessage(`Error during multiple pack operation: ${error}`);
    return '';
  }
}

export async function runCleanBuild(): Promise<void> {
  const category = 'Clean-Build';
  log(CHANNEL_NAME, category, 'Starting build directory cleanup');

  async function cleanBuildDir(directory: string) {
    const buildDir = path.join(directory, 'build');
    if (await fileExists(buildDir)) {
      const files = await readDirectory(buildDir);
      for (const [name, type] of files) {
        if (type === vscode.FileType.File) {
          await deleteFile(path.join(buildDir, name));
        }
      }
    }
  }

  // Clean root build directory
  await cleanBuildDir('.');

  // Recursively clean build directories in subdirectories
  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (
          type === vscode.FileType.Directory &&
          !EXCLUDED_DIRS.has(name.toLowerCase())
        ) {
          const subdir = path.join(dirPath, name);
          await cleanBuildDir(subdir);
          await processDirectory(subdir);
        }
      }
    } catch (error) {
      log(
        CHANNEL_NAME,
        category,
        `[Error] Error processing directory ${dirPath}: ${error}`,
      );
    }
  };

  await processDirectory('.');
  log(CHANNEL_NAME, category, 'Build directories cleaned');
}

export async function runCleanOutput(): Promise<void> {
  const category = 'Clean-Output';
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
            if (MODELS.some(model => name.includes(`_${model}`))) {
              filesToDelete.add(path.join(dirPath, name));
            }
          }
        }
      }
    } catch (error) {
      log(
        CHANNEL_NAME,
        category,
        `[Error] Error processing directory ${dirPath}: ${error}`,
      );
    }
  };

  await processDirectory('.');

  for (const file of filesToDelete) {
    await deleteFile(file);
  }

  log(CHANNEL_NAME, category, 'All AI Generated Output files cleaned');
}

export async function runPackLatexDiffVC(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  const category = 'Pack-Latex-Diff-VC';
  log(
    CHANNEL_NAME,
    category,
    `Starting LaTeX diff packing with inputFile=${inputFile}, commitHash=${commitHash}, clean=${clean}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  log(
    CHANNEL_NAME,
    category,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  log(CHANNEL_NAME, category, `File patterns: ${filePatterns}`);

  const filesToProcess: string[] = [];
  const filesToDelete: string[] = [];

  // Find files to process
  for (const pattern of filePatterns) {
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        log(CHANNEL_NAME, category, `Found file to process: ${filePath}`);
        filesToProcess.push(filePath);

        // Find associated temporary files
        for (const tempExt of TEMP_EXTENSIONS) {
          const tempFile = path.join(
            path.dirname(filePath),
            `${pattern}${tempExt}`,
          );
          if (await fileExists(tempFile)) {
            log(CHANNEL_NAME, category, `Found temporary file: ${tempFile}`);
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
      log(CHANNEL_NAME, category, 'Cleanup complete.');
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
        // Use fileUtils.createDirectory instead
        await createDirectory(outputFolder);
        log(
          CHANNEL_NAME,
          category,
          `Created output directory: ${outputFolder}`,
        );

        // Move main files
        for (const file of filesToProcess) {
          await moveFile(file, path.join(outputFolder, path.basename(file)));
        }

        // Delete temporary files
        for (const file of filesToDelete) {
          await deleteFile(file);
        }

        log(CHANNEL_NAME, category, `Files packed into ${outputFolder}`);
      } catch (error) {
        log(CHANNEL_NAME, category, `Error during packing: ${error}`);
        vscode.window.showErrorMessage(`Error during packing: ${error}`);
      }
    }
  } else {
    log(CHANNEL_NAME, category, 'No files found to process.');
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
  const category = 'Pack-Latex-Diff-VC-Multiple';
  log(
    CHANNEL_NAME,
    category,
    `Starting multiple LaTeX diff packing with commitHash=${commitHash}, clean=${clean}`,
  );
  log(CHANNEL_NAME, category, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    log(CHANNEL_NAME, category, '[Error] No input files provided', true);
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    log(CHANNEL_NAME, category, `Processing file: ${inputFile}`);
    await runPackLatexDiffVC(inputFile, commitHash, clean);
  }

  log(CHANNEL_NAME, category, 'Multiple LaTeX diff files processed');
}

export async function runCleanLatexDiffVC(
  inputFile: string,
  commitHash: string,
): Promise<void> {
  const category = 'Clean-Latex-Diff-VC';
  log(
    CHANNEL_NAME,
    category,
    `Starting LaTeX diff cleaning with inputFile=${inputFile}, commitHash=${commitHash}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  log(
    CHANNEL_NAME,
    category,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  log(CHANNEL_NAME, category, `File patterns: ${filePatterns}`);

  const filesToDelete: string[] = [];

  // Find files to delete
  for (const pattern of filePatterns) {
    // Find main files (.tex and .pdf)
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        log(CHANNEL_NAME, category, `Found main file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }

    // Find all temporary files
    for (const tempExt of TEMP_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, tempExt);
      if (filePath) {
        log(
          CHANNEL_NAME,
          category,
          `Found temporary file to delete: ${filePath}`,
        );
        filesToDelete.push(filePath);
      }

      // Also check in build directory
      const buildFilePath = await findFile(
        path.join(inputDir, 'build'),
        pattern,
        tempExt,
      );
      if (buildFilePath) {
        log(
          CHANNEL_NAME,
          category,
          `Found build file to delete: ${buildFilePath}`,
        );
        filesToDelete.push(buildFilePath);
      }
    }
  }

  if (filesToDelete.length > 0) {
    // Delete all found files
    for (const file of filesToDelete) {
      await deleteFile(file);
    }
    log(CHANNEL_NAME, category, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeX diff files cleaned');
  } else {
    log(CHANNEL_NAME, category, 'No files found to clean.');
    vscode.window.showInformationMessage('No LaTeX diff files found to clean');
  }
}

export async function runCleanLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  const category = 'Clean-Latex-Diff-VC-Multiple';
  log(
    CHANNEL_NAME,
    category,
    `Starting multiple LaTeX diff cleaning with commitHash=${commitHash}`,
  );
  log(CHANNEL_NAME, category, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    log(CHANNEL_NAME, category, '[Error] No input files provided', true);
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff cleaning',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    log(CHANNEL_NAME, category, `Processing file: ${inputFile}`);
    await runCleanLatexDiffVC(inputFile, commitHash);
  }

  log(CHANNEL_NAME, category, 'Multiple LaTeX diff files cleaned');
}

export async function runIndentTex(): Promise<void> {
  const category = 'Indent-Tex';
  log(CHANNEL_NAME, category, 'Starting LaTeX indentation process');

  // Get latexindent config from VS Code settings
  const config = getConfig().get<string>('latexindentConfig');
  log(CHANNEL_NAME, category, `LaTeX indent config: ${config}`);

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    log(CHANNEL_NAME, category, 'No workspace path found', true);
    vscode.window.showErrorMessage('No workspace path found');
    return;
  }

  if (config) {
    // Check if config file exists - use fs.access directly since this is an absolute path
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(config));
    } catch (error) {
      log(
        CHANNEL_NAME,
        category,
        `Error: Latexindent config file not found at ${config}`,
        true,
      );
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
          log(CHANNEL_NAME, category, `Processing file: ${fullPath}`);
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

            log(CHANNEL_NAME, category, `Executing command: ${command}`);
            try {
              const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
              if (stdout) {
                log(CHANNEL_NAME, category, `Command output: ${stdout}`);
              }
              if (stderr) {
                log(CHANNEL_NAME, category, `Command stderr: ${stderr}`, true);
              }
              log(CHANNEL_NAME, category, `Successfully indented: ${fullPath}`);
            } catch (execError) {
              log(CHANNEL_NAME, category, `Command error: ${execError}`, true);
              if (execError instanceof Error && 'stderr' in execError) {
                log(CHANNEL_NAME, category, `Command stderr: ${(execError as any).stderr}`, true);
              }
              continue;
            }
          } catch (error) {
            log(CHANNEL_NAME, category, `Error indenting file ${fullPath}: ${error}`);
            continue;
          }
        }
      }
    } catch (error) {
      log(CHANNEL_NAME, category, `Error processing directory ${dirPath}: ${error}`);
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
              log(CHANNEL_NAME, category, `Found cleanup file: ${fullPath}`);
              await deleteFile(fullPath);
            }
          }
        }
      } catch (error) {
        log(
          CHANNEL_NAME,
          category,
          `Error during cleanup in directory ${dirPath}: ${error}`, true
        );
      }
    };

    // Start cleanup from workspace root
    await processCleanup('.');

    log(CHANNEL_NAME, category, 'All .tex files have been indented');
  } catch (error) {
    log(CHANNEL_NAME, category, `Error during indentation process: ${error}`);
    vscode.window.showErrorMessage(`Error during indentation: ${error}`);
  }
}
