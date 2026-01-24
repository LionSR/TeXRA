// Standard library imports
import * as path from 'path';

// Local imports - shared schemas
import type { FileLocation } from '@shared/schemas';

// Local imports - utilities
import { createFileMapping, getComparablePath } from '@utils/files';

// Local file imports
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
   * Single-pass algorithm that checks all priority heuristics:
   * 1. Exact match: basename === source (immediate return)
   * 2. Names without extensions match
   * 3. Base name (no ext) matches source
   * 4. Source (no ext) matches base name
   */
  findMatchingBaseFile(source: string): FileLocation | undefined {
    const sourceNoExt = path.parse(source).name;
    let priority2Match: FileLocation | undefined;
    let priority3Match: FileLocation | undefined;
    let priority4Match: FileLocation | undefined;

    for (const baseLoc of this.baseFiles) {
      const baseName = this.getBaseName(baseLoc);
      const baseNameNoExt = path.parse(baseName).name;

      // Priority 1: Exact match - return immediately
      if (baseName === source) {
        return baseLoc;
      }

      // Track lower priority matches (first match for each priority wins)
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
