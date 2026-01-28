import * as path from 'path';

import {
  createFileMapping,
  getComparablePath,
  type FileLocation,
} from '@utils/files';

import type { OutputFileInfo } from '@shared/schemas';
import type { RoundFileMapping } from './types';

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

/** Calculates file lineage and mappings between base files and round outputs. */
export class FileLineageCalculator {
  constructor(private readonly baseFiles: FileLocation[]) {}

  calculateMapping(
    currentOutputs: OutputFileInfo[],
    previousOutputs: OutputFileInfo[],
  ): RoundFileMapping {
    const currentLocations = currentOutputs.map((entry) => entry.location);

    const baseToOutput = this.calculateBaseToOutputMapping(currentLocations);
    const prevToOutput = this.calculatePrevToOutputMapping(
      previousOutputs.map((entry) => entry.location),
      currentLocations,
    );

    const originByOutput = new Map<string, FileLocation | undefined>();
    for (const entry of currentOutputs) {
      const matchingBase = this.findMatchingBaseFile(entry.source);
      const outputPath = getComparablePath(entry.location);
      originByOutput.set(outputPath, matchingBase);
    }

    return { baseToOutput, prevToOutput, originByOutput };
  }

  /** Map output paths to base files using 'contains' strategy. */
  private calculateBaseToOutputMapping(
    currentLocations: FileLocation[],
  ): Map<string, FileLocation> {
    const forwardMapping = createFileMapping(
      this.baseFiles,
      currentLocations,
      'contains',
    );
    return invertMapping(forwardMapping, this.baseFiles);
  }

  /** Map output paths to previous round files using 'basename' strategy with round number stripping. */
  private calculatePrevToOutputMapping(
    prevLocations: FileLocation[],
    currentLocations: FileLocation[],
  ): Map<string, FileLocation> {
    if (prevLocations.length === 0) {
      return new Map();
    }

    const forwardMapping = createFileMapping(
      prevLocations,
      currentLocations,
      'basename',
      true,
    );
    return invertMapping(forwardMapping, prevLocations);
  }

  /**
   * Find base file matching source name using prioritized heuristics:
   * 1. Exact match  2. Names without extensions  3. Base name matches source  4. Source matches base name
   */
  findMatchingBaseFile(source: string): FileLocation | undefined {
    const sourceNoExt = path.parse(source).name;

    const candidates: Array<{ match: (b: string, bNoExt: string) => boolean }> =
      [
        { match: (b) => b === source },
        { match: (_, bNoExt) => bNoExt === sourceNoExt },
        { match: (_, bNoExt) => bNoExt === source },
        { match: (b) => b === sourceNoExt },
      ];

    for (const { match } of candidates) {
      for (const baseLoc of this.baseFiles) {
        const baseName = path.basename(
          baseLoc.kind !== 'external'
            ? baseLoc.relativePath
            : baseLoc.absolutePath,
        );
        const baseNameNoExt = path.parse(baseName).name;
        if (match(baseName, baseNameNoExt)) {
          return baseLoc;
        }
      }
    }

    return undefined;
  }
}
