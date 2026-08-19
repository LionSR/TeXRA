/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of output files back to their base files,
 * enabling proper diff computation and file history tracking.
 */

import * as path from 'node:path';

import { fileLocationDisplayPath, type FileLocation } from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { createFileMapping } from './fileMapping';

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
function findMatchingBaseFile(
  baseEntries: readonly BaseEntry[],
  source: string,
): FileLocation | undefined {
  const src = computePathKeys(source);

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
  const prevOutputs =
    currRound > 0 ? (state.rounds.get(currRound - 1)?.outputs ?? []) : [];

  const baseEntries: BaseEntry[] = baseFiles.map((loc) => ({
    loc,
    ...computePathKeys(fileLocationDisplayPath(loc)),
  }));
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
  // createFileMapping already returns an empty map when there are no
  // previous-round outputs to pair with.
  const prevToOutput = invertMapping(
    createFileMapping(prevLocations, currentLocations, 'basename', true),
    prevLocations,
  );

  const mapping = new Map<string, RoundFileEntry>();
  for (const entry of currentOutputs) {
    const key = fileLocationDisplayPath(entry.location);
    const origin = findMatchingBaseFile(baseEntries, entry.source);
    mapping.set(key, {
      base: origin ?? baseToOutput.get(key),
      prev: prevToOutput.get(key),
      origin,
    });
  }

  return mapping;
}
