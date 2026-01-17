// LSP-based tools (uses Lean 4 VS Code extension)
export { LeanDiagnosticsTool, LeanRestartTool, LeanGoalTool, LeanHoverTool } from './LspTools';
export type { LeanDiagnosticsInput, LeanRestartInput, LeanGoalInput, LeanHoverInput } from './LspTools';

// Web API tools
export { LeanLoogleTool } from './LoogleTool';
export type { LeanLoogleInput } from './LoogleTool';
