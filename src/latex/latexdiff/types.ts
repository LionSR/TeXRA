/** Shared result and progress types for a latexdiff run. */

/**
 * Minimal progress sink for long-running diff runs. Host-neutral so the core
 * latexdiff logic stays free of `vscode` — the VS Code command layer passes its
 * `vscode.Progress<…>`, which structurally satisfies this interface.
 */
export interface DiffProgressReporter {
  report(value: { message?: string; increment?: number }): void;
}

export type DiffRunResult =
  | {
      success: true;
      /** Absolute path of the generated diff, as reported by the diff service. */
      diffPath: string;
      message: string;
      description: string;
    }
  | {
      success: false;
      message: string;
      description: string;
    };

export interface DiffRunOutcome {
  results: DiffRunResult[];
}
