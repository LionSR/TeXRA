/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of output files back to their base files,
 * enabling proper diff computation and file history tracking.
 */

import * as path from 'node:path';

import type { FileLocation } from '@shared/schemas';
import { createFileMapping, getComparablePath } from '@utils/files';

import type { OutputState } from './outputState';
import type { RoundFileEntry, RoundFileMapping } from './types';

interface BaseEntry {
  readonly loc: FileLocation;
  readonly relativePath: string;
  readonly relativePathNoExt: string;
  readonly baseName: string;
  readonly baseNameNoExt: string;
}

/** Invert a Map<sourceKey, targetLocation> into Map<targetPath, sourceLocation>. */
function invertMapping(
  forwardMapping: Map<string, FileLocation>,
  sourceLocations: FileLocation[],
): Map<string, FileLocation> {
  const result = new Map<string, FileLocation>();
  const sourceByPath = new Map(
    sourceLocations.map((f) => [getComparablePath(f), f]),
  );

  for (const [sourcePath, targetLoc] of forwardMapping) {
    const sourceLoc = sourceByPath.get(sourcePath);
    if (sourceLoc) {
      result.set(getComparablePath(targetLoc), sourceLoc);
    }
  }

  return result;
}

function buildBaseEntries(baseFiles: FileLocation[]): BaseEntry[] {
  return baseFiles.map((baseLoc) => {
    const comparablePath = getComparablePath(baseLoc).replaceAll('\\', '/');
    const parsedPath = path.posix.parse(comparablePath);
    const relativePathNoExt = path.posix.join(parsedPath.dir, parsedPath.name);
    const baseName = path.posix.basename(comparablePath);
    return {
      loc: baseLoc,
      relativePath: comparablePath,
      relativePathNoExt,
      baseName,
      baseNameNoExt: path.posix.parse(baseName).name,
    };
  });
}

/**
 * Find the base file matching a model-reported source path.
 * Match full relative paths first, then fall back to basename-only matching for
 * legacy outputs that report just a filename.
 */
function findMatchingBaseFile(
  baseEntries: readonly BaseEntry[],
  source: string,
): FileLocation | undefined {
  const normalizedSource = source.replaceAll('\\', '/');
  const parsedSource = path.posix.parse(normalizedSource);
  const sourcePathNoExt = path.posix.join(parsedSource.dir, parsedSource.name);
  const sourceBaseName = path.posix.basename(normalizedSource);
  const sourceBaseNameNoExt = path.posix.parse(sourceBaseName).name;

  const matchers: Array<(entry: BaseEntry) => boolean> = [
    (entry) => entry.relativePath === normalizedSource,
    (entry) => entry.relativePathNoExt === sourcePathNoExt,
    (entry) => entry.baseName === normalizedSource,
    (entry) => entry.baseNameNoExt === sourceBaseNameNoExt,
    (entry) => entry.baseNameNoExt === normalizedSource,
    (entry) => entry.baseName === sourceBaseNameNoExt,
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
  const prevOutputs =
    currRound > 0 ? (state.rounds.get(currRound - 1)?.outputs ?? []) : [];

  const baseEntries = buildBaseEntries(baseFiles);
  const currentLocations = currentOutputs.map((entry) => entry.location);

  // 'contains' matches base filenames that appear as substrings of output names
  // (e.g. "paper" matches "paper_r1"), which handles round-suffixed rewrite outputs.
  const baseToOutput = invertMapping(
    createFileMapping(baseFiles, currentLocations, 'contains'),
    baseFiles,
  );

  const prevLocations = prevOutputs.map((entry) => entry.location);
  // 'basename' with roundAware=true strips round suffixes before comparing, so
  // "paper_r1" and "paper_r2" are treated as the same file across rounds.
  // Returns an empty map when there are no previous-round outputs to pair with.
  const prevToOutput =
    prevLocations.length === 0
      ? new Map<string, FileLocation>()
      : invertMapping(
          createFileMapping(prevLocations, currentLocations, 'basename', true),
          prevLocations,
        );

  const mapping = new Map<string, RoundFileEntry>();
  for (const entry of currentOutputs) {
    const key = getComparablePath(entry.location);
    const origin = findMatchingBaseFile(baseEntries, entry.source);
    mapping.set(key, {
      base: origin ?? baseToOutput.get(key),
      prev: prevToOutput.get(key),
      origin,
    });
  }

  return mapping;
}
