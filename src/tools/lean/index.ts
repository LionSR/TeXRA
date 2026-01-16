// CLI-based tools (simple, no persistent server)
export { LeanCheckTool, LakeBuildTool, LeanGoalTool } from './CliTools';
export type { LeanCheckInput, LakeBuildInput, LeanGoalInput } from './CliTools';

// LSP-based tools (rich, uses language server or VS Code extension)
export {
  LeanLspGoalTool,
  LeanHoverTool,
  LeanCompletionsTool,
  LeanTermGoalTool,
  LeanDiagnosticsTool,
} from './LspTools';
export type {
  LeanLspGoalInput,
  LeanHoverInput,
  LeanCompletionsInput,
  LeanDiagnosticsInput,
} from './LspTools';

// VS Code integration (primary when Lean 4 extension is installed)
export * as vscodeIntegration from './VscodeIntegration';

// Standalone LSP client utilities (fallback when VS Code extension unavailable)
export {
  getLspClient,
  disposeLspClient,
  LeanLspClient,
  DiagnosticSeverity,
} from './LeanLspClient';
export type {
  LspPosition,
  LspRange,
  LspDiagnostic,
  LeanGoalState,
  LeanTermGoal,
  HoverResult,
} from './LeanLspClient';
