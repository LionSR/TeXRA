/** Shared types for latexdiff output discovery and operation building. */

import type { FileLocation, OutputFileInfo } from '@shared/schemas';

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
