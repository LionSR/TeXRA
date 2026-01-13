// CLI-based tools (simple, no persistent server)
export { LeanCheckTool, LakeBuildTool, LeanGoalTool } from './CliTools';
export type { LeanCheckInput, LakeBuildInput, LeanGoalInput } from './CliTools';

// LSP-based tools (rich, uses language server)
export {
  LeanLspGoalTool,
  LeanHoverTool,
  LeanCompletionsTool,
  LeanTermGoalTool,
} from './LspTools';
export type {
  LeanLspGoalInput,
  LeanHoverInput,
  LeanCompletionsInput,
} from './LspTools';

// LSP client utilities
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
