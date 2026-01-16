// CLI-based tools (compile to check)
export { LeanCheckTool, LakeBuildTool, LeanGoalTool } from './CliTools';
export type { LeanCheckInput, LakeBuildInput, LeanGoalInput } from './CliTools';

// LSP-based tools (uses Lean 4 VS Code extension)
export {
  LeanLspGoalTool,
  LeanHoverTool,
  LeanDiagnosticsTool,
} from './LspTools';
export type {
  LeanLspGoalInput,
  LeanHoverInput,
  LeanDiagnosticsInput,
} from './LspTools';

// VS Code integration
export * as vscodeIntegration from './VscodeIntegration';
