// CLI-based tools
export { LakeBuildTool } from './CliTools';
export type { LakeBuildInput } from './CliTools';

// LSP-based tools (uses Lean 4 VS Code extension)
export {
  LeanLspGoalTool,
  LeanDiagnosticsTool,
  LeanRestartTool,
} from './LspTools';
export type {
  LeanLspGoalInput,
  LeanDiagnosticsInput,
  LeanRestartInput,
} from './LspTools';
