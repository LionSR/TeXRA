// Standard library imports
import * as path from 'node:path';

// Internal imports
import { createLog } from '@logger/logUtils';
import { getCleanAgentName, type FileOpResult } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  PACK_EXTENSIONS,
  TEMP_EXTENSIONS,
  HISTORY_DIR,
  CHANNEL,
} from './constants';
import {
  generateTimestamp,
  collectFilesFromPatterns,
  findFilesFromPatterns,
} from './utils';

const log = createLog(CHANNEL);

/**
 * Pack the source document's own files (`<base>.<ext>`, e.g. its PDF) into a
 * `History/` folder by copy, then sweep the source basename's build
 * artifacts. Workflow outputs live in run storage and are packed by
 * `runPackRunDir`; no workspace filename is parsed for them here.
 */
export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<FileOpResult> {
  log.info(
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  );

  if (!inputFile || !model || !agent) {
    log.error(
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    return { status: 'missingParams' };
  }
  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);

  const copiedFiles = [
    ...(await collectFilesFromPatterns(inputDir, [baseName], PACK_EXTENSIONS)),
  ];

  // Nothing to pack when the only match (if any) is the input document itself.
  if (copiedFiles.every((file) => file === inputFile)) {
    log.warn(`No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  }

  log.debug(`Files to copy:\n${copiedFiles.join('\n')}`);

  const cleanAgent = getCleanAgentName(agent);
  const resolvedOutputFolder =
    outputFolder ||
    path.join(
      inputDir,
      HISTORY_DIR,
      `${generateTimestamp()}_${baseName}_${cleanAgent}_${model}`,
    );
  log.debug(`Output folder: ${resolvedOutputFolder}`);

  try {
    await WorkspaceFS.createDir(resolvedOutputFolder);
    log.debug(`Created output directory: ${resolvedOutputFolder}`);

    for (const file of copiedFiles) {
      const destination = path.join(resolvedOutputFolder, path.basename(file));
      log.debug(`Copying: ${file} -> ${destination}`);
      await WorkspaceFS.copy(file, destination);
    }
    log.info(`Files packed into ${resolvedOutputFolder}`);

    // The source's own `<base>.bib` and `<base>.bak*` are the user's files,
    // not build artifacts: only sweep the source basename's generated ones.
    const packed = new Set(copiedFiles);
    for await (const file of findFilesFromPatterns(
      inputDir,
      [baseName],
      TEMP_EXTENSIONS.filter((ext) => ext !== '.bib' && ext !== '.bak*'),
    )) {
      if (!packed.has(file)) {
        await WorkspaceFS.delete(file);
      }
    }

    return { status: 'success', outputFolder: resolvedOutputFolder };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error(`Error during file operations: ${message}`);
    return { status: 'error', error: message };
  }
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<FileOpResult> {
  log.debug(
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  log.debug(`Additional files: ${inputFiles.join(', ')}`);

  const baseName = path.parse(inputFile).name;
  const outputDir = path.dirname(inputFile);
  const cleanAgent = getCleanAgentName(agent);
  const commonOutputFolder = path.join(
    outputDir,
    HISTORY_DIR,
    `${generateTimestamp()}_${baseName}_multiple_${cleanAgent}_${model}`,
  );
  log.debug(`Common output folder: ${commonOutputFolder}`);

  try {
    const allFilesToPack = [inputFile, ...inputFiles];
    const results = await Promise.all(
      allFilesToPack.map((file) =>
        runPackSingle(model, file, agent, commonOutputFolder),
      ),
    );
    // A per-file error takes precedence over partial success, so a failed
    // pack is never misreported as success or as 'noFiles'.
    const errored = results.find((r) => r.status === 'error');
    if (errored) return errored;

    if (results.some((r) => r.status === 'success')) {
      log.info(`All files packed into ${commonOutputFolder}`);
      return { status: 'success', outputFolder: commonOutputFolder };
    }

    log.warn(`No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error(`Error during multiple pack operation: ${message}`);
    return { status: 'error', error: message };
  }
}
