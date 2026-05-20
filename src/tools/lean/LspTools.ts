import { z } from 'zod';

import { toErrorMessage } from '@common/errors';
import type { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import {
  countBySeverity,
  formatCounts,
  formatGroupedSections,
} from '@utils/diagnostics/diagnosticFormatting';
import { getLeanVscodeServices } from './leanVscodeServices';
import { extractHoverText } from './leanTypes';

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

const FILE_COMMANDS = ['restart', 'refresh_dependencies'] as const;
type FileCommand = (typeof FILE_COMMANDS)[number];

const FILE_COMMAND_CONFIG: Record<
  FileCommand,
  { vscode: string; description: string }
> = {
  restart: {
    vscode: 'lean4.restartFile',
    description: 'Restart Lean server for this file',
  },
  refresh_dependencies: {
    vscode: 'lean4.refreshFileDependencies',
    description: 'Refresh file dependencies without full restart',
  },
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

const PROJECT_COMMAND_CONFIG: Record<
  ProjectCommand,
  { vscode: string; description: string }
> = {
  restart_server: {
    vscode: 'lean4.restartServer',
    description: 'Restart the entire Lean language server',
  },
  stop_server: {
    vscode: 'lean4.stopServer',
    description: 'Stop the Lean language server',
  },
  build: {
    vscode: 'lean4.project.build',
    description: 'Build the project (runs lake build)',
  },
  clean: {
    vscode: 'lean4.project.clean',
    description: 'Clean project build artifacts',
  },
  fetch_cache: {
    vscode: 'lean4.project.fetchCache',
    description: 'Download Mathlib build cache for the project',
  },
  fetch_file_cache: {
    vscode: 'lean4.project.fetchFileCache',
    description: "Download Mathlib cache for current file's imports only",
  },
  install_elan: {
    vscode: 'lean4.setup.installElan',
    description: 'Install Elan (Lean version manager)',
  },
  install_deps: {
    vscode: 'lean4.setup.installDeps',
    description: 'Install Lean dependencies',
  },
  update_elan: {
    vscode: 'lean4.setup.updateElan',
    description: 'Update Elan to latest version',
  },
  select_toolchain: {
    vscode: 'lean4.setup.selectDefaultToolchain',
    description: 'Select default Lean toolchain version',
  },
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

const NO_DIAGNOSTICS_HELP = `No errors, warnings, or hints for this file.

If you expected errors:
1. Import/dependency errors may not surface as diagnostics — check imports manually
2. Make sure the file is saved
3. Try \`lean_file\` with command "restart" to refresh the Lean server`;

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
- Import/dependency errors may not surface as diagnostics — check imports manually`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { command, file } = input;

    try {
      const diagnostics =
        await getLeanVscodeServices().fetchDiagnosticsForFile(file);
      if (!diagnostics) {
        return {
          summary: 'Failed to open file',
          output: `Could not open file: ${file}\n\nMake sure the file exists and is accessible.`,
          isError: true,
        };
      }

      await getLeanVscodeServices().navigateToFirstError(file, diagnostics);

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
        output: `Error: ${toErrorMessage(error)}\n\nIn VS Code: install the Lean 4 extension (leanprover.lean4). In CLI/desktop: install elan so that \`lake\` is on PATH, and make sure the file is inside a Lake project (lakefile.lean / lakefile.toml).`,
        isError: true,
      };
    }
  }
}

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
    const config = FILE_COMMAND_CONFIG[command];

    try {
      const success = await getLeanVscodeServices().executeFileCommand(
        config.vscode,
        file,
      );
      if (!success) {
        return {
          summary: 'Command failed',
          output: `Could not execute "${command}". Is the file open and the Lean 4 extension active?`,
          isError: true,
        };
      }
      return {
        summary: config.description,
        output: `Executed "${command}" on ${file}`,
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

Note: These commands do not capture output. For build output or other cases where you need captured stdout/stderr, use bash with lake CLI commands as fallback (e.g. lake build, lake env lean <file>, lake exe cache get).

Requires: Lean 4 VS Code extension installed.`,
  schema: LeanProjectInputSchema,
}) {
  protected async execute(input: LeanProjectInput): Promise<ToolResult> {
    const { command } = input;
    const config = PROJECT_COMMAND_CONFIG[command];

    try {
      await getLeanVscodeServices().executeGlobalCommand(config.vscode);

      if (command === 'build') {
        return {
          summary: config.description,
          output: `Build started. Note: this command does not capture build output directly.\n\nTo check for errors and warnings, run lean_diagnostics on the relevant .lean files.`,
        };
      }

      return {
        summary: config.description,
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
    const { data, error } = await getLeanVscodeServices().getGoalState(
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
      goalState: {
        goals: data.goals,
        count: goalCount,
        status: 'open' as const,
      },
    };
  }

  private async executeTermGoal(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await getLeanVscodeServices().getTermGoal(
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
    const { data, error } = await getLeanVscodeServices().getHoverInfo(
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

    const text = extractHoverText(data.contents);
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
