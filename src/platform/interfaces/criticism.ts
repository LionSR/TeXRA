/**
 * Host-resolved shape for a single criticism entry pushed by the diagnostics
 * tool's `add` command. The tool resolves the input `path` against the
 * active working directory before handing the entry to the host as
 * `absolutePath`.
 */
export interface ManualCriticismEntry {
  /** Absolute path resolved by the tool. */
  absolutePath: string;
  /** 1-based line number. */
  line: number;
  message: string;
  /** 0–5; mapped to DiagnosticSeverity by the host. */
  severity: number;
  /** 1–5; appended to the message as `(S/C)`. */
  confidence: number;
}

/**
 * Sink injected by the extension host for the `add` command. Returns
 * `accepted: false` when the experimental setting is disabled (or the host
 * has no inline-criticism surface, e.g. CLI/desktop) so the tool can surface
 * that to the agent.
 */
export type AddCriticismSink = (input: ManualCriticismEntry) => {
  accepted: boolean;
  resolvedPath: string;
};
