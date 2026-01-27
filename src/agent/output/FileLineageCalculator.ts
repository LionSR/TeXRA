import * as path from 'path';

import {
  createFileMapping,
  getComparablePath,
  type FileLocation,
} from '@utils/files';

import type { OutputFileInfo } from '@shared/schemas';
import type { RoundFileMapping } from './types';

/** Calculates file lineage and mappings between base files and round outputs. */
export class FileLineageCalculator {
  constructor(private readonly baseFiles: FileLocation[]) {}

  calculateMapping(
    currentOutputs: OutputFileInfo[],
    previousOutputs: OutputFileInfo[],
  ): RoundFileMapping {
    const currentLocations = currentOutputs.map((entry) => entry.location);
    const prevLocations = previousOutputs.map((entry) => entry.location);

    const baseToOutput = this.calculateBaseToOutputMapping(currentLocations);
    const prevToOutput = this.calculatePrevToOutputMapping(
      prevLocations,
      currentLocations,
    );
    const originByOutput = this.calculateOriginMapping(currentOutputs);

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

    const result = new Map<string, FileLocation>();
    const baseByPath = new Map(
      this.baseFiles.map((f) => [getComparablePath(f), f]),
    );

    for (const [basePath, outputLoc] of forwardMapping) {
      const baseLoc = baseByPath.get(basePath);
      if (baseLoc) {
        result.set(getComparablePath(outputLoc), baseLoc);
      }
    }

    return result;
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

    const result = new Map<string, FileLocation>();
    const prevByPath = new Map(
      prevLocations.map((f) => [getComparablePath(f), f]),
    );

    for (const [prevPath, outputLoc] of forwardMapping) {
      const prevLoc = prevByPath.get(prevPath);
      if (prevLoc) {
        result.set(getComparablePath(outputLoc), prevLoc);
      }
    }

    return result;
  }

  private calculateOriginMapping(
    currentOutputs: OutputFileInfo[],
  ): Map<string, FileLocation | undefined> {
    const originByOutput = new Map<string, FileLocation | undefined>();

    for (const entry of currentOutputs) {
      const matchingBase = this.findMatchingBaseFile(entry.source);
      const outputPath = getComparablePath(entry.location);
      originByOutput.set(outputPath, matchingBase);
    }

    return originByOutput;
  }

  /**
   * Find base file matching source name using prioritized heuristics:
   * 1. Exact match  2. Names without extensions  3. Base name matches source  4. Source matches base name
   */
  findMatchingBaseFile(source: string): FileLocation | undefined {
    const sourceNoExt = path.parse(source).name;
    let priority2Match: FileLocation | undefined;
    let priority3Match: FileLocation | undefined;
    let priority4Match: FileLocation | undefined;

    for (const baseLoc of this.baseFiles) {
      const baseName = this.getBaseName(baseLoc);
      const baseNameNoExt = path.parse(baseName).name;

      if (baseName === source) {
        return baseLoc;
      }

      if (!priority2Match && baseNameNoExt === sourceNoExt) {
        priority2Match = baseLoc;
      } else if (!priority3Match && baseNameNoExt === source) {
        priority3Match = baseLoc;
      } else if (!priority4Match && baseName === sourceNoExt) {
        priority4Match = baseLoc;
      }
    }

    return priority2Match ?? priority3Match ?? priority4Match;
  }

  private getBaseName(location: FileLocation): string {
    return path.basename(
      location.kind !== 'external'
        ? location.relativePath
        : location.absolutePath,
    );
  }
}
