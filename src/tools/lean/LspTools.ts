import { z } from 'zod';

import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { defineTool } from '@tools/core/define';
import { errorResult, executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  countBySeverity,
  formatCounts,
  formatGroupedSections,
} from '@utils/diagnostics/diagnosticFormatting';
import {
  LEAN_FILE_COMMANDS,
  LEAN_PROJECT_COMMANDS,
  extractHoverText,
  type LeanCommandSpec,
  type LeanFileCommand,
  type LeanProjectCommand,
} from './leanTypes';
import { getLeanLanguageServices } from './leanLanguageServices';

/** `- "name": Description (hint)` — the prose line for one command. */
function commandLine([name, spec]: [string, LeanCommandSpec]): string {
  return `- "${name}": ${spec.description}${spec.hint ? ` (${spec.hint})` : ''}`;
}

const FILE_COMMAND_NAMES = Object.keys(LEAN_FILE_COMMANDS) as LeanFileCommand[];
const FILE_COMMAND_PROSE = Object.entries(LEAN_FILE_COMMANDS)
  .map(commandLine)
  .join('\n');

const PROJECT_COMMAND_NAMES = Object.keys(
  LEAN_PROJECT_COMMANDS,
) as LeanProjectCommand[];

/** Project commands bucketed by their declared group, in declaration order. */
const PROJECT_COMMAND_GROUPS = ((): Map<
  string,
  [string, LeanCommandSpec][]
> => {
  const groups = new Map<string, [string, LeanCommandSpec][]>();
  for (const [name, spec] of Object.entries(LEAN_PROJECT_COMMANDS)) {
    const entries = groups.get(spec.group) ?? [];
    entries.push([name, spec]);
    groups.set(spec.group, entries);
  }
  return groups;
})();

const PROJECT_COMMAND_PROSE = [...PROJECT_COMMAND_GROUPS]
  .map(
    ([group, entries]) =>
      `${group} commands:\n${entries.map(commandLine).join('\n')}`,
  )
  .join('\n\n');

const PROJECT_COMMAND_GROUP_INDEX = [...PROJECT_COMMAND_GROUPS]
  .map(([group, entries]) => `${group}: ${entries.map(([n]) => n).join(', ')}`)
  .join('\n');

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

const LeanFileInputSchema = z.strictObject({
  /** Command to execute on the file */
  command: z
    .enum(FILE_COMMAND_NAMES)
    .describe(
      `Command: ${FILE_COMMAND_NAMES.map((name) => `"${name}"`).join(' or ')}`,
    ),
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanFileInput = z.infer<typeof LeanFileInputSchema>;

const LeanProjectInputSchema = z.strictObject({
  /** Command to execute */
  command: z
    .enum(PROJECT_COMMAND_NAMES)
    .describe(`Global command to execute:\n${PROJECT_COMMAND_GROUP_INDEX}`),
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
1. Import/dependency errors may not surface as diagnostics: check imports manually
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
- Import/dependency errors may not surface as diagnostics: check imports manually`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { command, file } = input;

    try {
      const diagnostics =
        await getLeanLanguageServices().fetchDiagnosticsForFile(file);
      if (!diagnostics) {
        return errorResult(
          `Could not open file: ${file}\n\nMake sure the file exists and is accessible.`,
          { summary: 'Failed to open file' },
        );
      }

      await getLeanLanguageServices().navigateToFirstError(file, diagnostics);

      const counts = countBySeverity(diagnostics);
      const countsStr = formatCounts(counts);

      if (diagnostics.length === 0) {
        return executed(NO_DIAGNOSTICS_HELP, '✓ No diagnostics');
      }

      const baseDiagnostics = { ...counts, total: diagnostics.length };

      if (command === 'count') {
        return {
          status: 'executed',
          summary: countsStr,
          output: `${file}: ${countsStr}`,
          diagnostics: baseDiagnostics,
        };
      }

      return {
        status: 'executed',
        summary: countsStr,
        output: formatGroupedSections(diagnostics),
        diagnostics: { ...baseDiagnostics, details: diagnostics },
      };
    } catch (error) {
      throw new ToolError(
        `Error: ${toErrorMessage(error)}\n\nIn VS Code: install the Lean 4 extension (leanprover.lean4). In CLI/desktop: install elan so that \`lake\` is on PATH, and make sure the file is inside a Lake project (lakefile.lean / lakefile.toml).`,
        { cause: error, summary: 'Failed to get diagnostics' },
      );
    }
  }
}

export class LeanFileTool extends defineTool({
  name: 'lean_file',
  description: `Execute Lean 4 extension commands on a specific file.

Commands:
${FILE_COMMAND_PROSE}

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanFileInputSchema,
}) {
  protected async execute(input: LeanFileInput): Promise<ToolResult> {
    const { command, file } = input;
    const { description } = LEAN_FILE_COMMANDS[command];

    try {
      const success = await getLeanLanguageServices().executeFileCommand(
        command,
        file,
      );
      if (!success) {
        return errorResult(
          `Could not execute "${command}". Is the file open and the Lean 4 extension active?`,
          { summary: 'Command failed' },
        );
      }
      return executed(`Executed "${command}" on ${file}`, description);
    } catch (error) {
      throw new ToolError(`Error: ${toErrorMessage(error)}`, {
        cause: error,
        summary: 'Command failed',
      });
    }
  }
}

export class LeanProjectTool extends defineTool({
  name: 'lean_project',
  description: `Execute global Lean 4 extension commands (no file required).

${PROJECT_COMMAND_PROSE}

In VS Code, these commands use the Lean 4 extension. CLI and desktop provide the corresponding direct operations where supported.`,
  schema: LeanProjectInputSchema,
}) {
  protected async execute(input: LeanProjectInput): Promise<ToolResult> {
    const { command } = input;
    const { description } = LEAN_PROJECT_COMMANDS[command];

    try {
      await getLeanLanguageServices().executeProjectCommand(command);

      if (command === 'build') {
        return executed(
          `Build started. Note: this command does not capture build output directly.\n\nTo check for errors and warnings, run lean_diagnostics on the relevant .lean files.`,
          description,
        );
      }

      return executed(`Executed "${command}" successfully`, description);
    } catch (error) {
      throw new ToolError(
        `Error executing "${command}": ${toErrorMessage(error)}`,
        {
          cause: error,
          summary: 'Command failed',
        },
      );
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

Goal results render Lean's own proof-state text, or a "no goals" message
when none remain (the proof may be complete, or the cursor may be outside
a tactic block).

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
        // Each dispatch is awaited inside the try so a rejected language-server
        // request lands in the catch below and carries a summary, matching the
        // sibling Lean tools.
        case 'goal':
          return await this.executeGoal(file, line0, col0, location);
        case 'term_goal':
          return await this.executeTermGoal(file, line0, col0, location);
        case 'hover':
          return await this.executeHover(file, line0, col0, location);
      }
    } catch (error) {
      throw new ToolError(`Error: ${toErrorMessage(error)}`, {
        cause: error,
        summary: `Failed to get ${type}`,
      });
    }
  }

  private async executeGoal(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await getLeanLanguageServices().getGoalState(
      file,
      line,
      column,
    );

    if (!data) {
      return this.noPositionData(
        'Could not get goal state',
        location,
        'No goal state',
        error,
      );
    }

    if (data.goals.length === 0) {
      return executed(
        'No goals at this position. The proof may be complete here.',
        'No goals',
      );
    }

    return executed(
      data.rendered,
      formatResultCount(data.goals.length, 'goal'),
    );
  }

  private async executeTermGoal(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await getLeanLanguageServices().getTermGoal(
      file,
      line,
      column,
    );

    if (!data) {
      return this.noPositionData(
        'No expected type',
        location,
        'No term goal',
        error,
      );
    }

    return executed(data.goal, 'Term goal');
  }

  private async executeHover(
    file: string,
    line: number,
    column: number,
    location: string,
  ): Promise<ToolResult> {
    const { data, error } = await getLeanLanguageServices().getHoverInfo(
      file,
      line,
      column,
    );

    if (!data) {
      return this.noPositionData(
        'No information',
        location,
        'No hover info',
        error,
      );
    }

    const text = extractHoverText(data.contents);
    if (!text) {
      return errorResult(`Empty hover response at ${location}`, {
        summary: 'No hover info',
      });
    }

    return executed(text, 'Hover info');
  }

  /**
   * Shared "language server returned nothing" error for the three inspect
   * dispatches. The optional LSP error string is surfaced inline so the
   * agent sees the underlying cause.
   */
  private noPositionData(
    message: string,
    location: string,
    summary: string,
    error?: string,
  ): ToolResult {
    return errorResult(
      `${message} at ${location}${error ? `\nError: ${error}` : ''}`,
      { summary },
    );
  }
}
