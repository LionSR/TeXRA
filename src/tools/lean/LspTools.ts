// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { toErrorMessage } from '@common/errors';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import {
  waitForDiagnosticsChange,
  countBySeverity,
  formatCounts,
  formatGroupedSections,
  DiagnosticSeverity,
} from '@frontend/vscode/vscodeDiagnostics';
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';

// Local imports - VS Code integration
import * as vscodeIntegration from './VscodeIntegration';

// ============================================================================
// Schema Definitions
// ============================================================================

const LeanDiagnosticsInputSchema = z.strictObject({
  /** Command: list for full messages, count for summary */
  command: z
    .enum(['list', 'count'])
    .prefault('list')
    .describe('Use "list" for full messages or "count" for summary only'),
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanDiagnosticsInput = z.infer<typeof LeanDiagnosticsInputSchema>;

// ============================================================================
// Lean File Tool (file-specific commands)
// ============================================================================

const FILE_COMMANDS = ['restart', 'refresh_dependencies'] as const;
type FileCommand = (typeof FILE_COMMANDS)[number];

const FILE_COMMAND_MAP: Record<FileCommand, string> = {
  restart: 'lean4.restartFile',
  refresh_dependencies: 'lean4.refreshFileDependencies',
};

const FILE_COMMAND_DESCRIPTIONS: Record<FileCommand, string> = {
  restart: 'Restart Lean server for this file',
  refresh_dependencies: 'Refresh file dependencies without full restart',
};

const LeanFileInputSchema = z.strictObject({
  /** Command to execute on the file */
  command: z
    .enum(FILE_COMMANDS)
    .describe('Command: "restart" or "refresh_dependencies"'),
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanFileInput = z.infer<typeof LeanFileInputSchema>;

// ============================================================================
// Lean Project Tool (global commands - project, server, and setup)
// ============================================================================

const PROJECT_COMMANDS = [
  // Server commands
  'restart_server',
  'stop_server',
  // Project commands
  'build',
  'clean',
  'fetch_cache',
  'fetch_file_cache',
  // Setup commands
  'install_elan',
  'install_deps',
  'update_elan',
  'select_toolchain',
] as const;
type ProjectCommand = (typeof PROJECT_COMMANDS)[number];

const PROJECT_COMMAND_MAP: Record<ProjectCommand, string> = {
  // Server
  restart_server: 'lean4.restartServer',
  stop_server: 'lean4.stopServer',
  // Project
  build: 'lean4.project.build',
  clean: 'lean4.project.clean',
  fetch_cache: 'lean4.project.fetchCache',
  fetch_file_cache: 'lean4.project.fetchFileCache',
  // Setup
  install_elan: 'lean4.setup.installElan',
  install_deps: 'lean4.setup.installDeps',
  update_elan: 'lean4.setup.updateElan',
  select_toolchain: 'lean4.setup.selectDefaultToolchain',
};

const PROJECT_COMMAND_DESCRIPTIONS: Record<ProjectCommand, string> = {
  // Server
  restart_server: 'Restart the entire Lean language server',
  stop_server: 'Stop the Lean language server',
  // Project
  build: 'Build the project (runs lake build)',
  clean: 'Clean project build artifacts',
  fetch_cache: 'Download Mathlib build cache for the project',
  fetch_file_cache: "Download Mathlib cache for current file's imports only",
  // Setup
  install_elan: 'Install Elan (Lean version manager)',
  install_deps: 'Install Lean dependencies',
  update_elan: 'Update Elan to latest version',
  select_toolchain: 'Select default Lean toolchain version',
};

const LeanProjectInputSchema = z.strictObject({
  /** Command to execute */
  command: z.enum(PROJECT_COMMANDS).describe(
    `Global command to execute:
Server: restart_server, stop_server
Project: build, clean, fetch_cache, fetch_file_cache
Setup: install_elan, install_deps, update_elan, select_toolchain`,
  ),
});

export type LeanProjectInput = z.infer<typeof LeanProjectInputSchema>;

// ============================================================================
// Lean Inspect Tool (position-based queries: goal or hover)
// ============================================================================

const INSPECT_TYPES = ['goal', 'term_goal', 'hover'] as const;

const LeanInspectInputSchema = z.strictObject({
  /** What to inspect: goal, term_goal, or hover */
  type: z
    .enum(INSPECT_TYPES)
    .describe(
      'What to inspect: "goal" for tactic proof state, "term_goal" for expected type in term mode, "hover" for type/docs',
    ),
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** 1-indexed line number */
  line: z.int().min(1).describe('Line number (1-indexed)'),
  /** 1-indexed column number */
  column: z
    .int()
    .min(1)
    .prefault(1)
    .describe('Column number (1-indexed, default: 1)'),
});

export type LeanInspectInput = z.infer<typeof LeanInspectInputSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

const NO_DIAGNOSTICS_HELP = `No errors, warnings, or hints for this file.

If you expected errors:
1. Check the Lean 4 output panel (import/dependency errors appear there)
2. Make sure the file is saved
3. Try \`lean_file\` with command "restart" to refresh the Lean server
4. Verify the Lean 4 extension is active (look for goal state in the infoview)`;

/** Navigate editor to first error location if present. */
async function navigateToFirstError(
  filePath: string,
  diagnostics: vscode.Diagnostic[],
): Promise<void> {
  const firstError = diagnostics.find(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (firstError) {
    await openFileInEditor(filePath, firstError.range.start.line + 1);
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get diagnostics for a Lean file from VS Code.
 */
export class LeanDiagnosticsTool extends defineTool({
  name: 'lean_diagnostics',
  description: `Get diagnostic messages (errors, warnings, info) for a Lean 4 file.

Commands:
- "list" (default): Full diagnostic messages with locations
- "count": Summary counts only (faster for checking if file compiles)

Returns diagnostics from the Lean 4 VS Code extension including:
- Compilation errors with location
- Type mismatches
- Unsolved goals
- Warnings and hints

Tips:
- If diagnostics seem stale, use lean_file with command "restart" to refresh the Lean server
- Import/dependency errors may only appear in the Lean 4 output panel

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { command, file } = input;

    try {
      const diagnostics = await this.fetchDiagnostics(file);
      if (!diagnostics) {
        return {
          summary: 'Failed to open file',
          output: `Could not open file: ${file}\n\nMake sure the file exists and is accessible.`,
          isError: true,
        };
      }

      await navigateToFirstError(file, diagnostics);

      const counts = countBySeverity(diagnostics);
      const countsStr = formatCounts(counts);

      if (diagnostics.length === 0) {
        return { summary: '✓ No diagnostics', output: NO_DIAGNOSTICS_HELP };
      }

      const baseDiagnostics = { ...counts, total: diagnostics.length };

      if (command === 'count') {
        return {
          summary: countsStr,
          output: `${file}: ${countsStr}`,
          diagnostics: baseDiagnostics,
        };
      }

      return {
        summary: countsStr,
        output: formatGroupedSections(diagnostics),
        diagnostics: { ...baseDiagnostics, details: diagnostics },
      };
    } catch (error) {
      return {
        summary: 'Failed to get diagnostics',
        output: `Error: ${toErrorMessage(error)}\n\nMake sure the Lean 4 VS Code extension is installed and active.`,
        isError: true,
      };
    }
  }

  /** Open file and wait for diagnostics to be published. */
  private async fetchDiagnostics(
    file: string,
  ): Promise<vscode.Diagnostic[] | null> {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(file));
    const diagnosticsWait = waitForDiagnosticsChange(uri, 10000);

    const openedPath = await openFileInEditor(file);
    if (!openedPath) return null;

    await diagnosticsWait;
    return vscodeIntegration.getDiagnostics(openedPath);
  }
}

/**
 * Execute file-specific Lean 4 extension commands.
 */
export class LeanFileTool extends defineTool({
  name: 'lean_file',
  description: `Execute Lean 4 extension commands on a specific file.

Commands:
- "restart": Restart Lean server for this file (use when diagnostics are stale or after editing imports)
- "refresh_dependencies": Refresh file dependencies without full restart (lighter than restart)

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanFileInputSchema,
}) {
  protected async execute(input: LeanFileInput): Promise<ToolResult> {
    const { command, file } = input;
    const vscodeCommand = FILE_COMMAND_MAP[command];
    const description = FILE_COMMAND_DESCRIPTIONS[command];

    try {
      const success = await vscodeIntegration.executeFileCommand(
        vscodeCommand,
        file,
      );

      if (success) {
        return {
          summary: description,
          output: `Executed "${command}" on ${file}`,
        };
      }

      return {
        summary: 'Command failed',
        output: `Could not execute "${command}". Is the file open and the Lean 4 extension active?`,
        isError: true,
      };
    } catch (error) {
      return {
        summary: 'Command failed',
        output: `Error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}

/**
 * Execute global Lean 4 extension commands (project, server, and setup).
 */
export class LeanProjectTool extends defineTool({
  name: 'lean_project',
  description: `Execute global Lean 4 extension commands (no file required).

Server commands:
- "restart_server": Restart the entire Lean language server
- "stop_server": Stop the Lean language server

Project commands:
- "build": Build the project (runs lake build)
- "clean": Clean project build artifacts
- "fetch_cache": Download Mathlib build cache for the entire project
- "fetch_file_cache": Download Mathlib cache for current file's imports only (faster)

Setup commands:
- "install_elan": Install Elan (the Lean version manager)
- "install_deps": Install Lean dependencies for the project
- "update_elan": Update Elan to the latest version
- "select_toolchain": Select the default Lean toolchain version

Requires: Lean 4 VS Code extension installed.`,
  schema: LeanProjectInputSchema,
}) {
  protected async execute(input: LeanProjectInput): Promise<ToolResult> {
    const { command } = input;
    const vscodeCommand = PROJECT_COMMAND_MAP[command];
    const description = PROJECT_COMMAND_DESCRIPTIONS[command];

    try {
      await vscode.commands.executeCommand(vscodeCommand);

      return {
        summary: description,
        output: `Executed "${command}" successfully`,
      };
    } catch (error) {
      return {
        summary: 'Command failed',
        output: `Error executing "${command}": ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}

/**
 * Inspect proof state or type info at a position in a Lean file.
 */
export class LeanInspectTool extends defineTool({
  name: 'lean_inspect',
  description: `Inspect proof state or type information at a position in a Lean 4 file.

Types:
- "goal": Get tactic proof state (what needs to be proven)
- "term_goal": Get expected type at cursor in term mode
- "hover": Get type signature and documentation for an identifier

Goal results include a goalState payload with:
- count: number of goals
- status: "noGoals" when count is 0 (proof may be complete, or cursor may be outside a tactic block), "open" when goals remain
- goals: raw goal list from Lean

Line and column are 1-indexed.

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanInspectInputSchema,
}) {
  protected async execute(input: LeanInspectInput): Promise<ToolResult> {
    const { type, file, line, column } = input;
    // Convert to 0-indexed for LSP
    const line0 = line - 1;
    const col0 = column - 1;
    const location = `${file}:${line}:${column}`;

    try {
      switch (type) {
        case 'goal':
          return this.executeGoal(file, line0, col0, location);
        case 'term_goal':
          return this.executeTermGoal(file, line0, col0, location);
        case 'hover':
          return this.executeHover(file, line0, col0, location);
      }
    } catch (error) {
      return {
        summary: `Failed to get ${type}`,
        output: `Error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }

  private async executeGoal(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await vscodeIntegration.getGoalState(
      file,
      line,
      column,
    );

    if (!data) {
      return {
        summary: 'No goal state',
        output: `Could not get goal state at ${location}${error ? `\nError: ${error}` : ''}`,
        isError: true,
      };
    }

    if (data.goals.length === 0) {
      return {
        summary: 'No goals',
        output: 'No goals at this position. The proof may be complete here.',
        goalState: { goals: [], count: 0, status: 'noGoals' as const },
      };
    }

    const goalCount = data.goals.length;
    return {
      summary: `${goalCount} goal${goalCount > 1 ? 's' : ''}`,
      output: data.rendered,
      goalState: { goals: data.goals, count: goalCount, status: 'open' as const },
    };
  }

  private async executeTermGoal(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await vscodeIntegration.getTermGoal(
      file,
      line,
      column,
    );

    if (!data) {
      return {
        summary: 'No term goal',
        output: `No expected type at ${location}${error ? `\nError: ${error}` : ''}`,
        isError: true,
      };
    }

    return { summary: 'Term goal', output: data.goal };
  }

  private async executeHover(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await vscodeIntegration.getHoverInfo(
      file,
      line,
      column,
    );

    if (!data) {
      return {
        summary: 'No hover info',
        output: `No information at ${location}${error ? `\nError: ${error}` : ''}`,
        isError: true,
      };
    }

    const text = vscodeIntegration.extractHoverText(data.contents);
    if (!text) {
      return {
        summary: 'No hover info',
        output: `Empty hover response at ${location}`,
        isError: true,
      };
    }

    return { summary: 'Hover info', output: text };
  }
}
