/** Shared types for the latexdiff command group. */

import type { FileLocation, OutputFileInfo } from '@shared/schemas';

export interface RunLatexdiffCommandConfig {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  outputFilesActive?: string[];
  streamId?: string;
  runId?: string | null;
  outputsByRound?: Record<string, OutputFileInfo[]>;
}

export interface DiffRunResult {
  success: boolean;
  message?: string;
  basePath?: string;
  diffFileName?: string;
  description?: string;
}

export interface DiffRunOutcome {
  results: DiffRunResult[];
  totalOperations: number;
}

export type DiffOperationType = 'round' | 'between-rounds';

export interface DiffOperation {
  type: DiffOperationType;
  base: FileLocation;
  revised: FileLocation;
  description: string;
  cwd?: string;
  round?: number;
  fromRound?: number;
  toRound?: number;
}
