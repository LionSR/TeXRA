/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of a round's output files back to their base files.
 * Extraction (`computeOutputDiffStats`) is its one caller: the lineage it
 * records on each output is what every later reader (latexdiff, the critic's
 * review, the hosts) takes, never a recomputation. Its pairing of outputs with
 * bases (`pairOutputsWithBases`) also drives the `\input` rewrite, which runs
 * before lineage is recorded.
 */

import * as path from 'node:path';
import {
  normalizeFilePath,
  fileLocationDisplayPath,
  type FileLocation,
} from '@texra-ai/harness/schemas';

import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';

/** File relationship facts for a single output path. All fields optional — absence means no match. */
interface RoundFileEntry {
  /** Base FileLocation for round-based diffs (rewrite agents). */
  base?: FileLocation;
  /**
   * Original base FileLocation for lineage tracking. `pairOutputsWithBases`
   * coalesces `base: origin ?? …`, so `origin` set implies `base` set — do
   * not reintroduce an "origin but no base" fallback.
   */
  origin?: FileLocation;
}

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
 * `paper_revised.tex`); a target two sources of that length fit is mapped to
 * neither. Uses string keys (comparable paths) for robust
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
      if (!targetBaseName.includes(sourceName)) continue;
      if (sourceName.length > bestMatchScore) {
        bestMatchScore = sourceName.length;
        bestMatchSourcePath = sourcePath;
      } else if (sourceName.length === bestMatchScore) {
        bestMatchSourcePath = null;
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
 * The base a model-reported document name revises, or none when the name
 * fits no base or several. The readings run from the most specific to the
 * least: the path as written (with, then without, its extension), a path the
 * base's ends with (an external base carries only its absolute path), then
 * the file name alone, for a reply that reports just a file name. The first
 * reading any base fits answers; when it fits two, the name is ambiguous
 * (`main.tex` against `a/main.tex` and `b/main.tex`) and pairs with none.
 */
export function baseOf(
  bases: readonly FileLocation[],
  source: string,
): FileLocation | undefined {
  const src = computePathKeys(source);
  const entries: BaseEntry[] = bases.map((loc) => ({
    loc,
    ...computePathKeys(fileLocationDisplayPath(loc)),
  }));

  const readings: ((entry: BaseEntry) => boolean)[] = [
    (entry) => entry.relativePath === src.relativePath,
    (entry) => entry.relativePathNoExt === src.relativePathNoExt,
    (entry) => entry.relativePath.endsWith(`/${src.relativePath}`),
    (entry) => entry.baseNameNoExt === src.baseNameNoExt,
    (entry) => entry.baseNameNoExt === src.relativePath,
    (entry) => entry.baseName === src.baseNameNoExt,
  ];

  for (const fits of readings) {
    const matched = entries.filter(fits);
    if (matched.length > 0)
      return matched.length === 1 ? matched[0]?.loc : undefined;
  }
  return undefined;
}

/**
 * Pair each output with its base file, keyed by the output's display path:
 * `origin` is the base its model-reported source names ({@link baseOf}).
 * When the model chose a new name (`paper_revised.tex`), `base` falls back
 * to the base whose file name the output's name contains, and with a single
 * base, to that base: an agent that extracts several documents from one
 * input (`chapter1`, `methods`) revises it under names it does not share.
 */
export function pairOutputsWithBases(
  baseFiles: FileLocation[],
  outputs: readonly Pick<OutputFileInfo, 'source' | 'location'>[],
): Map<string, RoundFileEntry> {
  const baseToOutput = invertMapping(
    createFileMapping(
      baseFiles,
      outputs.map((entry) => entry.location),
    ),
    baseFiles,
  );

  const onlyBase = baseFiles.length === 1 ? baseFiles[0] : undefined;

  const mapping = new Map<string, RoundFileEntry>();
  for (const entry of outputs) {
    const key = fileLocationDisplayPath(entry.location);
    const origin = baseOf(baseFiles, entry.source);
    mapping.set(key, {
      base:
        origin ??
        baseToOutput.get(key) ??
        (onlyBase && fileLocationDisplayPath(onlyBase) !== key
          ? onlyBase
          : undefined),
      origin,
    });
  }

  return mapping;
}
