/** Shared types for latexdiff output discovery and operation building. */

import type {
  FileLocation,
  OutputFileInfo,
  RoundIndexed,
} from '@shared/schemas';

/**
 * Minimal progress sink for long-running diff runs. Host-neutral so the core
 * latexdiff logic stays free of `vscode` — the VS Code command layer passes its
 * `vscode.Progress<…>`, which structurally satisfies this interface.
 */
export interface DiffProgressReporter {
  report(value: { message?: string; increment?: number }): void;
}

export interface RunLatexdiffCommandConfig {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  outputFilesActive?: string[];
  streamId?: string;
  runId?: string | null;
  outputsByRound?: RoundIndexed<OutputFileInfo>;
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

interface DiffOperationBase {
  base: FileLocation;
  revised: FileLocation;
  description: string;
  cwd: string;
}

export interface RoundDiffOperation extends DiffOperationBase {
  type: 'round';
  round: number;
}

export interface BetweenRoundsDiffOperation extends DiffOperationBase {
  type: 'between-rounds';
  fromRound: number;
  toRound: number;
}

export type DiffOperation = RoundDiffOperation | BetweenRoundsDiffOperation;
