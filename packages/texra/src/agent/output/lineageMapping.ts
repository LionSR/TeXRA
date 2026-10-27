/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of a round's output files back to their base files.
 * Extraction (`computeOutputDiffStats`) is its one caller: the lineage it
 * records on each output is what every later reader (latexdiff, the critic's
 * review, the hosts) takes, never a recomputation. Its source matcher
 * (`findMatchingBaseFile`) also pairs outputs with bases for the `\input`
 * rewrite, which runs before lineage is recorded.
 */

import * as path from 'node:path';
import {
  normalizeFilePath,
  fileLocationDisplayPath,
  type FileLocation,
} from '@texra-ai/harness/schemas';

import type { OutputState } from './outputState';
import type { RoundFileEntry, RoundFileMapping } from './types';

interface PathKeys {
  readonly relativePath: string;
  readonly relativePathNoExt: string;
  readonly baseName: string;
  readonly baseNameNoExt: string;
}

interface BaseEntry extends PathKeys {
  readonly loc: FileLocation;
}

/** Normalize a path and derive the relative/basename keys used for matching. */
function computePathKeys(filePath: string): PathKeys {
  const relativePath = normalizeFilePath(filePath);
  const parsed = path.posix.parse(relativePath);
  return {
    relativePath,
    relativePathNoExt: path.posix.join(parsed.dir, parsed.name),
    baseName: parsed.base,
    baseNameNoExt: parsed.name,
  };
}

/**
 * Map each source file to the target whose file name contains the source's
 * name without its extension, the longest such name winning (`paper` matches
 * `paper_revised.tex`). Uses string keys (comparable paths) for robust
 * lookups, FileLocation values for data, so lookups work even when
 * FileLocation objects are reconstructed.
 *
 * @returns Map from source path to target FileLocation
 */
function createFileMapping(
  sourceFiles: FileLocation[],
  targetFiles: FileLocation[],
): Map<string, FileLocation> {
  const fileMapping = new Map<string, FileLocation>();

  if (sourceFiles.length === 0 || targetFiles.length === 0) {
    return fileMapping;
  }

  const baseNameOf = (filePath: string): string =>
    path.parse(path.basename(filePath)).name;

  // Source names do not depend on the target, so derive them once up front.
  const sources = sourceFiles.map((sourceFile) => {
    const sourcePath = fileLocationDisplayPath(sourceFile);
    return { sourcePath, sourceName: baseNameOf(sourcePath) };
  });

  for (const target of targetFiles) {
    const targetPath = fileLocationDisplayPath(target);
    const targetBaseName = path.basename(targetPath);

    let bestMatchSourcePath: string | null = null;
    let bestMatchScore = 0;

    for (const { sourcePath, sourceName } of sources) {
      if (
        targetBaseName.includes(sourceName) &&
        sourceName.length > bestMatchScore
      ) {
        bestMatchScore = sourceName.length;
        bestMatchSourcePath = sourcePath;
      }
    }

    if (bestMatchSourcePath) {
      fileMapping.set(bestMatchSourcePath, target);
    }
  }

  return fileMapping;
}

/** Invert a Map<sourceKey, targetLocation> into Map<targetPath, sourceLocation>. */
function invertMapping(
  forwardMapping: Map<string, FileLocation>,
  sourceLocations: FileLocation[],
): Map<string, FileLocation> {
  const result = new Map<string, FileLocation>();
  const sourceByPath = new Map(
    sourceLocations.map((f) => [fileLocationDisplayPath(f), f]),
  );

  for (const [sourcePath, targetLoc] of forwardMapping) {
    const sourceLoc = sourceByPath.get(sourcePath);
    if (sourceLoc) {
      result.set(fileLocationDisplayPath(targetLoc), sourceLoc);
    }
  }

  return result;
}

/**
 * Find the base file matching a model-reported source path.
 * Match full relative paths first, then fall back to basename-only matching for
 * legacy outputs that report just a filename.
 */
export function findMatchingBaseFile(
  baseFiles: readonly FileLocation[],
  source: string,
): FileLocation | undefined {
  const src = computePathKeys(source);
  const baseEntries: BaseEntry[] = baseFiles.map((loc) => ({
    loc,
    ...computePathKeys(fileLocationDisplayPath(loc)),
  }));

  const matchers: ((entry: BaseEntry) => boolean)[] = [
    (entry) => entry.relativePath === src.relativePath,
    (entry) => entry.relativePathNoExt === src.relativePathNoExt,
    (entry) => entry.baseName === src.relativePath,
    (entry) => entry.baseNameNoExt === src.baseNameNoExt,
    (entry) => entry.baseNameNoExt === src.relativePath,
    (entry) => entry.baseName === src.baseNameNoExt,
  ];

  for (const match of matchers) {
    for (const entry of baseEntries) {
      if (match(entry)) return entry.loc;
    }
  }

  return undefined;
}

/** Traces file lineage for a round's outputs. */
export function traceFileLineage(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
): RoundFileMapping {
  const currentOutputs = state.rounds.get(currRound)?.outputs ?? [];

  const currentLocations = currentOutputs.map((entry) => entry.location);

  // Base filenames that appear as substrings of output names (e.g. "paper"
  // matches "paper_revised"), for outputs whose names the model chose.
  const baseToOutput = invertMapping(
    createFileMapping(baseFiles, currentLocations),
    baseFiles,
  );

  const mapping = new Map<string, RoundFileEntry>();
  for (const entry of currentOutputs) {
    const key = fileLocationDisplayPath(entry.location);
    const origin = findMatchingBaseFile(baseFiles, entry.source);
    mapping.set(key, {
      base: origin ?? baseToOutput.get(key),
      origin,
    });
  }

  return mapping;
}
