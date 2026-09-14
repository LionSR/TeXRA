// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Internal imports
import { withLogChannel, withLogData } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import { getCleanAgentName, type FileOpResult } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { copyFileExclusive } from '@utils/files/fsDurability';

// Local file imports
import {
  PACK_EXTENSIONS,
  TEMP_EXTENSIONS,
  HISTORY_DIR,
  CHANNEL,
} from './constants';
import { generateTimestamp, collectFilesFromPatterns } from './utils';

/** Every pack failure reaches the host as the same result shape. */
const asErrorResult = (error: unknown) =>
  Effect.logError('Error during file operations').pipe(
    withLogData(error),
    withLogChannel(CHANNEL),
    Effect.as<FileOpResult>({ status: 'error', error: toErrorMessage(error) }),
  );

/**
 * Pack the source document's own files (`<base>.<ext>`, e.g. its PDF) into a
 * `History/` folder by copy, then sweep the source basename's build
 * artifacts. Workflow outputs live in run storage and are packed by
 * `runPackRunDir`; no workspace filename is parsed for them here.
 */
export const runPackSingle = Effect.fn('housekeeping.runPackSingle')(function* (
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
) {
  yield* Effect.logInfo(
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  ).pipe(withLogChannel(CHANNEL));

  if (!inputFile || !model || !agent) {
    yield* Effect.logError(
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    ).pipe(withLogChannel(CHANNEL));
    return { status: 'missingParams' } satisfies FileOpResult;
  }

  const workspaceFs = yield* WorkspaceFs;
  const workspaceRoot = workspaceFs.root;
  if (!workspaceRoot) return { status: 'noFiles' } satisfies FileOpResult;

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);

  return yield* Effect.gen(function* () {
    const copiedFiles = [
      ...(yield* collectFilesFromPatterns(
        workspaceRoot,
        inputDir,
        [baseName],
        PACK_EXTENSIONS,
      )),
    ];

    // Nothing to pack when the only match (if any) is the input document.
    if (copiedFiles.every((file) => file === inputFile)) {
      yield* Effect.logWarning(`No files found to pack for ${inputFile}`).pipe(
        withLogChannel(CHANNEL),
      );
      return { status: 'noFiles' } satisfies FileOpResult;
    }

    yield* Effect.logDebug(`Files to copy:\n${copiedFiles.join('\n')}`).pipe(
      withLogChannel(CHANNEL),
    );

    const cleanAgent = getCleanAgentName(agent);
    const resolvedOutputFolder =
      outputFolder ||
      path.join(
        inputDir,
        HISTORY_DIR,
        `${generateTimestamp()}_${baseName}_${cleanAgent}_${model}`,
      );

    yield* workspaceFs.makeDirectory(resolvedOutputFolder, {
      recursive: true,
    });
    yield* Effect.logDebug(
      `Created output directory: ${resolvedOutputFolder}`,
    ).pipe(withLogChannel(CHANNEL));

    for (const file of copiedFiles) {
      const destination = path.join(resolvedOutputFolder, path.basename(file));
      yield* Effect.logDebug(`Copying: ${file} -> ${destination}`).pipe(
        withLogChannel(CHANNEL),
      );
      // Exclusive: the check and the creation are one step, so when
      // `runPackMultiple` packs two same-basename sources into one folder
      // concurrently, the losing copy fails with `AlreadyExists` and its pack
      // reports the collision instead of silently omitting its file.
      yield* copyFileExclusive(
        yield* workspaceFs.resolve(file),
        yield* workspaceFs.resolve(destination),
      );
    }
    yield* Effect.logInfo(`Files packed into ${resolvedOutputFolder}`).pipe(
      withLogChannel(CHANNEL),
    );

    // The source's own `<base>.bib` and `<base>.bak*` are the user's files,
    // not build artifacts: only sweep the source basename's generated ones.
    const packed = new Set(copiedFiles);
    const sweepable = yield* collectFilesFromPatterns(
      workspaceRoot,
      inputDir,
      [baseName],
      TEMP_EXTENSIONS.filter((ext) => ext !== '.bib' && ext !== '.bak*'),
    );
    for (const file of sweepable) {
      if (!packed.has(file)) {
        yield* workspaceFs.remove(file, { force: true });
      }
    }

    return {
      status: 'success',
      outputFolder: resolvedOutputFolder,
    } satisfies FileOpResult;
  }).pipe(Effect.catch(asErrorResult));
});

export const runPackMultiple = Effect.fn('housekeeping.runPackMultiple')(
  function* (
    model: string,
    inputFile: string,
    agent: string,
    inputFiles: string[],
  ) {
    yield* Effect.logDebug(
      `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}; additional files: ${inputFiles.join(', ')}`,
    ).pipe(withLogChannel(CHANNEL));

    const baseName = path.parse(inputFile).name;
    const outputDir = path.dirname(inputFile);
    const cleanAgent = getCleanAgentName(agent);
    const commonOutputFolder = path.join(
      outputDir,
      HISTORY_DIR,
      `${generateTimestamp()}_${baseName}_multiple_${cleanAgent}_${model}`,
    );

    const allFilesToPack = [inputFile, ...inputFiles];
    const results = yield* Effect.forEach(
      allFilesToPack,
      (file) => runPackSingle(model, file, agent, commonOutputFolder),
      { concurrency: 'unbounded' },
    );

    // A per-file error takes precedence over partial success, so a failed
    // pack is never misreported as success or as 'noFiles'.
    const errored = results.find((result) => result.status === 'error');
    if (errored) return errored;

    if (results.some((result) => result.status === 'success')) {
      yield* Effect.logInfo(`All files packed into ${commonOutputFolder}`).pipe(
        withLogChannel(CHANNEL),
      );
      return {
        status: 'success',
        outputFolder: commonOutputFolder,
      } satisfies FileOpResult;
    }

    yield* Effect.logWarning(`No files found to pack for ${inputFile}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { status: 'noFiles' } satisfies FileOpResult;
  },
);
