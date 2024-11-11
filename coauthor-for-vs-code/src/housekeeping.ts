import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspacePath, getConfig } from './utils/commonUtils';

let outputChannel: vscode.OutputChannel;
outputChannel = vscode.window.createOutputChannel('Coauthor Housekeeping');

const EXCLUDED_DIRS = new Set([
  'Figs',
  'Figures',
  'build',
  'Versions',
  'versions',
  'figs',
  'figures',
  'Notes',
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
  outputChannel.appendLine(`Getting agent first name chunk for: ${agent}`);
  let result: string;
  if (agent.startsWith('write-')) {
    result = agent.split('-')[1];
  } else {
    result = agent.includes('_') ? agent.split('_')[0] : agent.split('-')[0];
  }
  outputChannel.appendLine(`Agent first name chunk: ${result}`);
  return result;
}

function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 4,
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

async function deleteFile(filePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.delete(uri, { useTrash: false });
    outputChannel.appendLine(`Deleted: ${filePath}`);
  } catch (error) {
    if (error instanceof vscode.FileSystemError) {
      vscode.window.showWarningMessage(
        `Unable to delete ${filePath}. It may be in use.`,
      );
    } else {
      vscode.window.showErrorMessage(`Error deleting ${filePath}: ${error}`);
    }
  }
}

async function moveFile(source: string, destination: string): Promise<void> {
  outputChannel.appendLine(`Moving file from ${source} to ${destination}`);
  try {
    const sourceUri = vscode.Uri.file(source);
    const destUri = vscode.Uri.file(destination);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
    if (!sourceExists) {
      outputChannel.appendLine(`[Error] Source file doesn't exist: ${source}`);
      return;
    }

    await vscode.workspace.fs.rename(sourceUri, destUri);
    outputChannel.appendLine(`Successfully moved: ${source} to ${destination}`);
  } catch (error) {
    outputChannel.appendLine(
      `[Error] Error moving file from ${source} to ${destination}: ${error}`,
    );
    vscode.window.showErrorMessage(`Error moving file: ${error}`);
  }
}

async function copyFile(source: string, destination: string): Promise<void> {
  outputChannel.appendLine(`Copying file from ${source} to ${destination}`);
  try {
    const sourceUri = vscode.Uri.file(source);
    const destUri = vscode.Uri.file(destination);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
    if (!sourceExists) {
      outputChannel.appendLine(`[Error] Source file doesn't exist: ${source}`);
      return;
    }

    await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: true });
    outputChannel.appendLine(
      `Successfully copied: source=${source} to destination=${destination}`,
    );
  } catch (error) {
    outputChannel.appendLine(
      `[Error] Error copying file from source=${source} to destination=${destination}: ${error}`,
    );
    vscode.window.showErrorMessage(`Error copying file: ${error}`);
  }
}

async function findFile(
  inputDir: string,
  pattern: string,
  ext?: string,
): Promise<string | null> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return null;

  const searchDirs = [
    path.join(workspacePath, inputDir, 'build'),
    path.join(workspacePath, inputDir),
  ];

  for (const searchDir of searchDirs) {
    try {
      const dirUri = vscode.Uri.file(searchDir);

      const exists = await vscode.workspace.fs.stat(dirUri).then(
        () => true,
        () => false,
      );
      if (!exists) {
        outputChannel.appendLine(`Directory doesn't exist: ${searchDir}`);
        continue;
      }

      const files = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [fileName, fileType] of files) {
        if (fileType === vscode.FileType.File) {
          if (ext) {
            if (fileName === `${pattern}${ext}`) {
              const foundPath = path.join(searchDir, fileName);
              outputChannel.appendLine(`Found file: ${foundPath}`);
              return foundPath;
            }
          } else if (fileName.startsWith(pattern)) {
            const foundPath = path.join(searchDir, fileName);
            outputChannel.appendLine(`Found file: ${foundPath}`);
            return foundPath;
          }
        }
      }
    } catch (error) {
      outputChannel.appendLine(
        `Error searching directory searchDir=${searchDir}: ${error}`,
      );
      continue;
    }
  }
  return null;
}

export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<void> {
  outputChannel.appendLine(
    `runCleanSingle called with: model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  if (!inputFile || !model || !agent) {
    outputChannel.appendLine(
      `[Error] Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for clean single',
    );
    return;
  }

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    outputChannel.appendLine('[Error] No workspace path found');
    return;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  outputChannel.appendLine(
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = getFilePatterns(baseName, model, agentFirstNameChunk);
  outputChannel.appendLine(`Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  outputChannel.appendLine(`Using extensions: ${extensions}`);

  let filesFound = false;
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = path.join(workspacePath, inputDir, `${pattern}${ext}`);
      const buildFilePath = path.join(
        workspacePath,
        inputDir,
        'build',
        `${pattern}${ext}`,
      );

      try {
        const uri = vscode.Uri.file(filePath);
        const exists = await vscode.workspace.fs.stat(uri).then(
          () => true,
          () => false,
        );
        if (exists) {
          outputChannel.appendLine(`Found file to delete: ${filePath}`);
          filesFound = true;
          await deleteFile(filePath);
        }
      } catch (error) {
        outputChannel.appendLine(`File not found or error: ${filePath}`);
      }

      try {
        const buildUri = vscode.Uri.file(buildFilePath);
        const buildExists = await vscode.workspace.fs.stat(buildUri).then(
          () => true,
          () => false,
        );
        if (buildExists) {
          outputChannel.appendLine(
            `Found build file to delete: ${buildFilePath}`,
          );
          filesFound = true;
          await deleteFile(buildFilePath);
        }
      } catch (error) {
        outputChannel.appendLine(
          `Build file not found or error: ${buildFilePath}`,
        );
      }
    }
  }

  if (!filesFound) {
    outputChannel.appendLine(
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
  outputChannel.appendLine(
    `runPackSingle called with: model=${model}, inputFile=${inputFile}, agent=${agent}, ${outputFolder}`,
  );
  if (!inputFile || !model || !agent) {
    outputChannel.appendLine(
      `[ERROR] Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for pack single',
    );
    return '';
  }

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    outputChannel.appendLine('[Error] No workspace path found');
    return '';
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  outputChannel.appendLine(
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentFirstNameChunk),
    baseName,
  ];
  outputChannel.appendLine(`Generated patterns: ${filePatterns}`);

  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];

  // Find files to move or copy
  for (const pattern of filePatterns) {
    for (const ext of PACK_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath) {
        outputChannel.appendLine(`Found file: ${filePath}`);
        if (
          filePath === path.join(workspacePath, inputFile) ||
          pattern === baseName
        ) {
          copiedFiles.push(filePath);
        } else {
          movedFiles.push(filePath);
        }
      }
    }
  }

  outputChannel.appendLine(`Files to move: ${movedFiles}`);
  outputChannel.appendLine(`Files to copy: ${copiedFiles}`);

  if (movedFiles.length > 0 || copiedFiles.length > 0) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    outputFolder =
      outputFolder ||
      path.join(
        workspacePath,
        inputDir,
        'Versions',
        `${now}_${baseName}_${agent}_${model}`,
      );
    outputChannel.appendLine(`Output folder: ${outputFolder}`);

    try {
      // Create output directory
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputFolder));
      outputChannel.appendLine(`Created output directory: ${outputFolder}`);

      // Move and copy files
      for (const file of movedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        outputChannel.appendLine(`Moving file from ${file} to ${destination}`);
        await moveFile(file, destination);
      }
      for (const file of copiedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        outputChannel.appendLine(`Copying file from ${file} to ${destination}`);
        await copyFile(file, destination);
      }

      vscode.window.showInformationMessage(`Files packed into ${outputFolder}`);
    } catch (error) {
      outputChannel.appendLine(`Error during file operations: ${error}`);
      vscode.window.showErrorMessage(`Error during packing: ${error}`);
    }
  } else {
    outputChannel.appendLine(`No files found to pack for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to pack for ${inputFile}`,
    );
  }

  // Clean up temporary files
  for (const pattern of filePatterns) {
    for (const ext of TEMP_EXTENSIONS) {
      const filePath = await findFile(inputDir, pattern, ext);
      if (filePath && filePath !== path.join(workspacePath, inputFile)) {
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
  outputChannel.appendLine(
    `runCleanMultiple called with: model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  outputChannel.appendLine(`Additional files: ${inputFiles.join(', ')}`);

  await runCleanSingle(model, inputFile, agent);

  // Clean input files
  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      await runCleanSingle(model, file, agent);
    }
  }

  vscode.window.showInformationMessage('Cleanup complete for multiple files.');
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  inputFiles: string[],
  agent: string,
  outputNameOverride?: string,
): Promise<string> {
  outputChannel.appendLine(
    `runPackMultiple called with: model=${model}, inputFile=${inputFile}, agent=${agent}, outputNameOverride=${outputNameOverride}`,
  );
  outputChannel.appendLine(`Additional files: ${inputFiles.join(', ')}`);

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    outputChannel.appendLine('[Error] No workspace path found');
    return '';
  }

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
    workspacePath,
    outputDir,
    'Versions',
    `${now}_${baseName}_multiple_${agent}_${model}`,
  );
  outputChannel.appendLine(`Common output folder: ${commonOutputFolder}`);

  try {
    // Create output directory
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(commonOutputFolder),
    );
    outputChannel.appendLine(`Created output directory: ${commonOutputFolder}`);

    // Pack main input file or override file
    if (outputNameOverride) {
      await runPackSingle(model, outputNameOverride, agent, commonOutputFolder);
    } else {
      await runPackSingle(model, inputFile, agent, commonOutputFolder);
    }

    // Pack input files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        outputChannel.appendLine(`Packing input file: ${file}`);
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
      const filePath = path.join(workspacePath, outputDir, pattern);
      try {
        const fileUri = vscode.Uri.file(filePath);
        const exists = await vscode.workspace.fs.stat(fileUri).then(
          () => true,
          () => false,
        );
        if (exists) {
          outputChannel.appendLine(`Found additional XML file: ${filePath}`);
          await moveFile(filePath, path.join(commonOutputFolder, pattern));
        }
      } catch (error) {
        outputChannel.appendLine(`XML file not found or error: ${filePath}`);
        continue;
      }
    }

    vscode.window.showInformationMessage(
      `All files packed into ${commonOutputFolder}`,
    );
    return commonOutputFolder;
  } catch (error) {
    outputChannel.appendLine(`Error during multiple pack operation: ${error}`);
    vscode.window.showErrorMessage(
      `Error during multiple pack operation: ${error}`,
    );
    return '';
  }
}

export async function runCleanBuild(): Promise<void> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  async function cleanBuildDir(directory: string) {
    const buildDir = path.join(directory, 'build');
    try {
      const buildDirUri = vscode.Uri.file(buildDir);
      const exists = await vscode.workspace.fs.stat(buildDirUri).then(
        () => true,
        () => false,
      );

      if (exists) {
        const files = await vscode.workspace.fs.readDirectory(buildDirUri);
        for (const [name, type] of files) {
          if (type === vscode.FileType.File) {
            await deleteFile(path.join(buildDir, name));
          }
        }
      }
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  }

  // Clean root build directory
  await cleanBuildDir(workspacePath);

  // Recursively clean build directories in subdirectories
  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(dirPath),
      );
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
      outputChannel.appendLine(
        `[Error] Error processing directory ${dirPath}: ${error}`,
      );
    }
  };

  await processDirectory(workspacePath);
  vscode.window.showInformationMessage('Build directories cleaned');
}

export async function runCleanOutput(): Promise<void> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const patterns = MODELS.map((model) => `*_${model}*.tex`);
  const patternsBuild = MODELS.map((model) => `*/build/*_${model}*`);

  const filesToDelete = new Set<string>();

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(dirPath),
      );
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }

        if (type === vscode.FileType.Directory) {
          await processDirectory(path.join(dirPath, name));
        } else if (type === vscode.FileType.File) {
          // Check if file matches any pattern
          for (const model of MODELS) {
            if (name.includes(`_${model}`) && name.endsWith('.tex')) {
              filesToDelete.add(path.join(dirPath, name));
            }
            if (name.includes(`_${model}`) && name.endsWith('.pdf')) {
              filesToDelete.add(path.join(dirPath, name));
            }
            if (name.includes(`_${model}`) && name.endsWith('.xml')) {
              filesToDelete.add(path.join(dirPath, name));
            }
          }
        }
      }
    } catch (error) {
      outputChannel.appendLine(
        `[Error] Error processing directory ${dirPath}: ${error}`,
      );
    }
  };

  await processDirectory(workspacePath);

  for (const file of filesToDelete) {
    await deleteFile(file);
  }

  vscode.window.showInformationMessage('All AI Generated Output files cleaned');
}
