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
   * Returns a map from output path to base location.
   */
  private calculateBaseToOutputMapping(
    currentLocations: FileLocation[],
  ): Map<string, FileLocation> {
    const forwardMapping = createFileMapping(
      this.baseFiles,
      currentLocations,
      'contains',
    );

    // Invert: forward is basePath -> outputLoc, we need outputPath -> baseLoc
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

  /**
   * Calculate mapping from current output paths to their previous round counterparts.
   * Uses 'basename' strategy with round number stripping for inter-round matching.
   * Returns a map from output path to previous round location.
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

    // Invert: forward is prevPath -> outputLoc, we need outputPath -> prevLoc
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

  /**
   * Calculate origin mapping using prioritized heuristics to match output files
   * to their original base files.
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
   * Tries heuristics in priority order (first match wins):
   * 1. Exact match: basename === source
   * 2. Names without extensions match
   * 3. Base name (no ext) matches source
   * 4. Source (no ext) matches base name
   */
  findMatchingBaseFile(source: string): FileLocation | undefined {
    const sourceNoExt = path.parse(source).name;

    // Priority 1: Exact match
    for (const baseLoc of this.baseFiles) {
      if (this.getBaseName(baseLoc) === source) {
        return baseLoc;
      }
    }

    // Priority 2: Names without extensions match
    for (const baseLoc of this.baseFiles) {
      const baseNameNoExt = path.parse(this.getBaseName(baseLoc)).name;
      if (baseNameNoExt === sourceNoExt) {
        return baseLoc;
      }
    }

    // Priority 3: Base name (no ext) matches source exactly
    for (const baseLoc of this.baseFiles) {
      const baseNameNoExt = path.parse(this.getBaseName(baseLoc)).name;
      if (baseNameNoExt === source) {
        return baseLoc;
      }
    }

    // Priority 4: Source (no ext) matches base name exactly
    for (const baseLoc of this.baseFiles) {
      if (this.getBaseName(baseLoc) === sourceNoExt) {
        return baseLoc;
      }
    }

    return undefined;
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
