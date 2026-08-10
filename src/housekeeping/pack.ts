// Standard library imports
import * as path from 'node:path';

// Internal imports
import * as logger from '@logger/logUtils';
import { getCleanAgentName } from '@shared/schemas/agent';
import type { FileOpResult } from '@shared/schemas/opResults';
import {
  getAgentFirstNameChunk,
  parseWorkflowOutputRoundDir,
  workflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  PACK_EXTENSIONS,
  TEMP_EXTENSIONS,
  HISTORY_DIR,
  DEFAULT_MAX_ROUNDS,
  CHANNEL,
} from './constants';
import {
  generateTimestamp,
  collectFilesFromPatterns,
  findFilesFromPatterns,
  resolveHousekeepingTargets,
} from './utils';

export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  );

  const targets = resolveHousekeepingTargets(model, inputFile, agent);
  if (!targets) {
    return { status: 'missingParams' };
  }
  const { baseName, inputDir } = targets;
  // Pack also matches the input document itself (it is copied, not moved).
  const filePatterns = [...targets.filePatterns, baseName];

  const allFiles = await collectFilesFromPatterns(
    inputDir,
    filePatterns,
    PACK_EXTENSIONS,
  );

  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];
  for (const file of allFiles) {
    if (file === inputFile || path.parse(file).name === baseName) {
      copiedFiles.push(file);
    } else {
      movedFiles.push(file);
    }
  }

  // Nothing to move, and the only copy (if any) is the input document itself.
  const noFilesToPack =
    movedFiles.length === 0 &&
    (copiedFiles.length === 0 ||
      (copiedFiles.length === 1 && copiedFiles[0] === inputFile));

  if (noFilesToPack) {
    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  }

  logger.debug(CHANNEL, buildFileListLog(movedFiles, copiedFiles));

  const resolvedOutputFolder =
    outputFolder ||
    path.join(
      inputDir,
      HISTORY_DIR,
      `${generateTimestamp()}_${baseName}_${agent}_${model}`,
    );
  logger.debug(CHANNEL, `Output folder: ${resolvedOutputFolder}`);

  try {
    await WorkspaceFS.createDir(resolvedOutputFolder);
    logger.debug(CHANNEL, `Created output directory: ${resolvedOutputFolder}`);

    const operations = await moveAndCopyFiles(
      movedFiles,
      copiedFiles,
      resolvedOutputFolder,
    );

    if (operations.length > 0) {
      logger.info(CHANNEL, `Files packed into ${resolvedOutputFolder}`);
      logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
    }

    await cleanupTempFiles(inputDir, filePatterns, movedFiles, copiedFiles);

    return { status: 'success', outputFolder: resolvedOutputFolder };
  } catch (err) {
    const message = toErrorMessage(err);
    logger.error(CHANNEL, `Error during file operations: ${message}`);
    return { status: 'error', error: message };
  }
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const baseName = path.parse(inputFile).name;
  const outputDir = path.dirname(inputFile);
  const commonOutputFolder = path.join(
    outputDir,
    HISTORY_DIR,
    `${generateTimestamp()}_${baseName}_multiple_${agent}_${model}`,
  );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    const allFilesToPack = [inputFile, ...inputFiles];
    const results = await Promise.all(
      allFilesToPack.map((file) =>
        runPackSingle(model, file, agent, commonOutputFolder),
      ),
    );
    const anyFilesPacked = results.some((r) => r.status === 'success');

    const xmlFilesPacked = await packAdditionalXmlFiles(
      outputDir,
      baseName,
      agent,
      model,
      commonOutputFolder,
      anyFilesPacked,
    );

    if (anyFilesPacked || xmlFilesPacked) {
      logger.info(CHANNEL, `All files packed into ${commonOutputFolder}`);
      return { status: 'success', outputFolder: commonOutputFolder };
    }

    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  } catch (err) {
    const message = toErrorMessage(err);
    logger.error(CHANNEL, `Error during multiple pack operation: ${message}`);
    return { status: 'error', error: message };
  }
}

function buildFileListLog(movedFiles: string[], copiedFiles: string[]): string {
  const parts = ['Found files to process:'];
  if (movedFiles.length > 0) {
    parts.push(`Files to move:\n${movedFiles.join('\n')}`);
  }
  if (copiedFiles.length > 0) {
    parts.push(`Files to copy:\n${copiedFiles.join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * Compute a destination basename that preserves round identity.
 *
 * Files matched from the new round-subfolder layout (`<dir>/r{round}/<base>.<ext>`)
 * would otherwise collapse to `<base>.<ext>` and overwrite each other when
 * multiple rounds exist. Detect an `r{N}/` ancestor in the source path and
 * prefix the basename with `r{N}_` so each round packs to a distinct entry.
 */
function packDestinationName(file: string): string {
  const base = path.basename(file);
  const segments = path.dirname(file).split(/[\\/]+/);
  for (const segment of segments.toReversed()) {
    const round = parseWorkflowOutputRoundDir(segment);
    if (round !== null) {
      return `${workflowOutputRoundDir(round)}_${base}`;
    }
  }
  return base;
}

async function moveAndCopyFiles(
  movedFiles: string[],
  copiedFiles: string[],
  outputFolder: string,
): Promise<string[]> {
  const operations: string[] = [];

  for (const file of movedFiles) {
    const destination = path.join(outputFolder, packDestinationName(file));
    operations.push(`Moving: ${file} -> ${destination}`);
    await WorkspaceFS.rename(file, destination);
  }

  for (const file of copiedFiles) {
    const destination = path.join(outputFolder, packDestinationName(file));
    operations.push(`Copying: ${file} -> ${destination}`);
    await WorkspaceFS.copy(file, destination);
  }

  return operations;
}

async function cleanupTempFiles(
  inputDir: string,
  filePatterns: string[],
  movedFiles: string[],
  copiedFiles: string[],
): Promise<void> {
  const skip = new Set([...movedFiles, ...copiedFiles]);

  for await (const file of findFilesFromPatterns(
    inputDir,
    filePatterns,
    TEMP_EXTENSIONS,
  )) {
    if (!skip.has(file)) {
      await WorkspaceFS.delete(file);
    }
  }
}

async function packAdditionalXmlFiles(
  outputDir: string,
  baseName: string,
  agent: string,
  model: string,
  commonOutputFolder: string,
  outputFolderExists: boolean,
): Promise<boolean> {
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const cleanAgent = getCleanAgentName(agent);
  const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);

  let anyPacked = false;
  for (let i = 0; i < maxRounds; i++) {
    // Both layouts: legacy flat `<base>_<chunk>_r{round}_<model>.xml` and
    // new round-subfolder `r{round}/<base>_<cleanAgent>_<model>.xml`.
    const candidates = [
      {
        rel: `${baseName}_${agentFirstNameChunk}_r${i}_${model}.xml`,
        dest: `${baseName}_${agentFirstNameChunk}_r${i}_${model}.xml`,
      },
      {
        rel: path.join(`r${i}`, `${baseName}_${cleanAgent}_${model}.xml`),
        dest: `${baseName}_${cleanAgent}_r${i}_${model}.xml`,
      },
    ];

    for (const { rel, dest } of candidates) {
      const filePath = path.join(outputDir, rel);
      if (!(await WorkspaceFS.exists(filePath))) continue;

      const destPath = path.join(commonOutputFolder, dest);
      if (await WorkspaceFS.exists(destPath)) {
        // Legacy and new layouts can yield identical destination names
        // (when `agentFirstNameChunk === cleanAgent`). Skip the second
        // candidate rather than failing the rename onto an existing file.
        logger.debug(
          CHANNEL,
          `Skipping ${filePath}: destination ${destPath} already exists`,
        );
        continue;
      }

      if (!outputFolderExists && !anyPacked) {
        await WorkspaceFS.createDir(commonOutputFolder);
      }
      logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
      await WorkspaceFS.rename(filePath, destPath);
      anyPacked = true;
    }
  }

  return anyPacked;
}
