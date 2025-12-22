import * as path from 'path';

import {
  createFileMapping,
  getComparablePath,
  type FileLocation,
} from '@utils/files';

import type { OutputFileInfo, RoundFileMapping } from './types';

/**
 * Calculates file lineage and mappings between base files, previous round outputs,
 * and current round outputs.
 *
 * This consolidates the file matching heuristics in one place, making them:
 * - Easier to test
 * - Easier to understand and modify
 * - Reusable across different contexts
 */
export class FileLineageCalculator {
  constructor(private readonly baseFiles: FileLocation[]) {}

  /**
   * Calculate the complete round mapping for a given round's outputs.
   *
   * @param currentOutputs - Output files from the current round
   * @param previousOutputs - Output files from the previous round (empty for round 0)
   * @returns RoundFileMapping with baseToOutput, prevToOutput, and originByOutput maps
   */
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

  /**
   * Calculate mapping from current output paths to their base file origins.
   * Uses 'contains' strategy - output filename should contain base filename.
   */
  private calculateBaseToOutputMapping(
    currentLocations: FileLocation[],
  ): Map<string, FileLocation> {
    const forwardMapping = createFileMapping(
      this.baseFiles,
      currentLocations,
      'contains',
    );

    // Invert the mapping: output path -> base location
    const baseToOutput = new Map<string, FileLocation>();
    for (const [basePath, outputLoc] of forwardMapping) {
      const baseLoc = this.baseFiles.find(
        (f) => getComparablePath(f) === basePath,
      );
      if (baseLoc) {
        baseToOutput.set(getComparablePath(outputLoc), baseLoc);
      }
    }

    return baseToOutput;
  }

  /**
   * Calculate mapping from current output paths to their previous round counterparts.
   * Uses 'basename' strategy with round number stripping for inter-round matching.
   */
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
      true, // Strip round numbers for matching
    );

    // Invert the mapping: output path -> previous location
    const prevToOutput = new Map<string, FileLocation>();
    for (const [prevPath, outputLoc] of forwardMapping) {
      const prevLoc = prevLocations.find(
        (f) => getComparablePath(f) === prevPath,
      );
      if (prevLoc) {
        prevToOutput.set(getComparablePath(outputLoc), prevLoc);
      }
    }

    return prevToOutput;
  }

  /**
   * Calculate origin mapping using multiple heuristics to match output files
   * to their original base files.
   *
   * Matching heuristics (in order):
   * 1. Exact match: basename === source
   * 2. Name without extension match
   * 3. Base name matches source (without extension)
   * 4. Source matches base name (without extension)
   */
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
   * Find the base file that matches the given source name.
   * Uses multiple heuristics for flexible matching.
   */
  findMatchingBaseFile(source: string): FileLocation | undefined {
    const sourceNoExt = path.parse(source).name;

    return this.baseFiles.find((baseLoc) => {
      const baseName = this.getBaseName(baseLoc);
      const baseNameNoExt = path.parse(baseName).name;

      // Try multiple matching strategies
      return (
        baseName === source || // Exact match
        baseNameNoExt === sourceNoExt || // Names without extensions match
        baseNameNoExt === source || // Base name matches source
        baseName === sourceNoExt // Source name matches base
      );
    });
  }

  /**
   * Get the basename from a FileLocation, handling different location kinds.
   */
  private getBaseName(location: FileLocation): string {
    return path.basename(
      location.kind !== 'external'
        ? location.relativePath
        : location.absolutePath,
    );
  }
}
