export interface LocDelta {
  current: number;
  baseline: number;
  delta: number;
}

export function countLines(content: string): number;

export function computeLocDelta(
  currentLoc: number,
  baselineLoc: number,
): LocDelta;

export function collectTestKernelFiles(dir: string): string[];
