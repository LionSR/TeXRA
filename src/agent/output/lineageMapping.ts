/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of output files back to their base files,
 * enabling proper diff computation and file history tracking.
 */

import * as path from 'path';

import type { FileLocation } from '@shared/schemas';
import { createFileMapping, getComparablePath } from '@utils/files';

import type { OutputState } from './outputState';
import type { RoundFileMapping } from './types';

interface BaseEntry {
  readonly loc: FileLocation;
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
    const baseName = path.basename(
      baseLoc.kind !== 'external' ? baseLoc.relativePath : baseLoc.absolutePath,
    );
    return {
      loc: baseLoc,
      baseName,
      baseNameNoExt: path.parse(baseName).name,
    };
  });
}

/**
 * Find base file matching source name using prioritized heuristics:
 * 1. Exact match
 * 2. Names without extensions
 * 3. Base name matches source
 * 4. Source matches base name
 */
function findMatchingBaseFile(
  baseEntries: readonly BaseEntry[],
  source: string,
): FileLocation | undefined {
  const sourceNoExt = path.parse(source).name;

  const matchers: Array<(b: string, bNoExt: string) => boolean> = [
    (b) => b === source,
    (_b, bNoExt) => bNoExt === sourceNoExt,
    (_b, bNoExt) => bNoExt === source,
    (b) => b === sourceNoExt,
  ];

  for (const match of matchers) {
    for (const { loc, baseName, baseNameNoExt } of baseEntries) {
      if (match(baseName, baseNameNoExt)) {
        return loc;
      }
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

  // Map output paths to base files using 'contains' strategy.
  const baseToOutput = invertMapping(
    createFileMapping(baseFiles, currentLocations, 'contains'),
    baseFiles,
  );

  // Map output paths to previous round files using 'basename' strategy with
  // round number stripping. Returns an empty map when there are no previous
  // outputs to map from.
  const prevLocations = prevOutputs.map((entry) => entry.location);
  const prevToOutput =
    prevLocations.length === 0
      ? new Map<string, FileLocation>()
      : invertMapping(
          createFileMapping(prevLocations, currentLocations, 'basename', true),
          prevLocations,
        );

  const originByOutput = new Map<string, FileLocation | undefined>();
  for (const entry of currentOutputs) {
    originByOutput.set(
      getComparablePath(entry.location),
      findMatchingBaseFile(baseEntries, entry.source),
    );
  }

  return { baseToOutput, prevToOutput, originByOutput };
}
