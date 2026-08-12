/** Shared types for latexdiff output discovery and operation building. */

import type { LaTeXdiffService } from '../latexdiff';
import type { FileLocation } from '@shared/schemas';
import type { RunLatexdiffForExecutionParams } from './runLatexdiff';

/**
 * Host-supplied latexdiff runtime: the diff service instance bound to the
 * caller's own logger channel. Keeps the host-neutral engine from importing a
 * module-scope singleton (or the extension command group's channel name).
 */
export interface LatexdiffRuntime {
  /** Logger channel the diff run reports under (host-specific). */
  readonly channel: string;
  /** Diff service instance bound to that channel. */
  readonly service: LaTeXdiffService;
}

/**
 * Minimal progress sink for long-running diff runs. Host-neutral so the core
 * latexdiff logic stays free of `vscode` — the VS Code command layer passes its
 * `vscode.Progress<…>`, which structurally satisfies this interface.
 */
export interface DiffProgressReporter {
  report(value: { message?: string; increment?: number }): void;
}

/**
 * Command-payload config for a latexdiff run. The six run-scoped fields are
 * the shared subset of {@link RunLatexdiffForExecutionParams} — declared once
 * there, derived here — so command handlers can forward a config straight into
 * `runLatexdiffForExecution` without re-declaring or re-mapping the shape.
 */
export type RunLatexdiffCommandConfig = Pick<
  RunLatexdiffForExecutionParams,
  'agent' | 'model' | 'inputFile' | 'outputFiles' | 'runId' | 'outputsByRound'
>;

export interface DiffRunResult {
  success: boolean;
  message?: string;
  basePath?: string;
  diffFileName?: string;
  description?: string;
}

export interface DiffRunOutcome {
  results: DiffRunResult[];
}

interface DiffOperationBase {
  base: FileLocation;
  revised: FileLocation;
  description: string;
  cwd: string;
}

interface RoundDiffOperation extends DiffOperationBase {
  type: 'round';
  round: number;
}

interface BetweenRoundsDiffOperation extends DiffOperationBase {
  type: 'between-rounds';
  fromRound: number;
  toRound: number;
}

export type DiffOperation = RoundDiffOperation | BetweenRoundsDiffOperation;
