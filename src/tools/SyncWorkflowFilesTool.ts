/**
 * Tool for syncing workflow-generated files back to the workspace.
 *
 * After a workflow agent completes, its output files live in run storage
 * (taskRuns/{executionId}/). This tool copies selected files from run
 * storage into the workspace, replacing local files — the programmatic
 * equivalent of the "Accept" button in the progress view.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import {
  StorageFS,
  WorkspaceFS,
  flexibleFS,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import type { ExecutionId } from '@shared/schemas';

// ============================================================================
// Schema
// ============================================================================

const FileMapping = z.strictObject({
  /** File path within the run (as shown by /runs/{id}/files). */
  source: z.string().describe('File path within the run storage'),
  /**
   * Workspace-relative destination path.
   * If omitted, defaults to source (same relative path).
   */
  destination: z
    .string()
    .nullish()
    .describe(
      'Workspace-relative destination path. Defaults to source path if omitted.',
    ),
  /** Lines added (from subagent-result output-files metadata). */
  added: z.number().nullish().describe('Lines added (from output-files metadata)'),
  /** Lines removed (from subagent-result output-files metadata). */
  removed: z.number().nullish().describe('Lines removed (from output-files metadata)'),
});

const SyncWorkflowFilesInputSchema = z.strictObject({
  /** Execution ID of the completed workflow run. */
  execution_id: z.string().describe('Execution ID to sync files from'),
  /** Files to sync from run storage to workspace. */
  files: z
    .array(FileMapping)
    .min(1)
    .describe('Files to copy from run storage to workspace'),
});

export type SyncWorkflowFilesInput = z.infer<
  typeof SyncWorkflowFilesInputSchema
>;

// ============================================================================
// Tool Implementation
// ============================================================================

export class SyncWorkflowFilesTool extends defineTool({
  name: 'sync_workflow_files',
  description: `Sync workflow-generated files from run storage to the workspace.

Copies selected output files from a completed workflow run into the workspace,
replacing existing files.

Parameters:
- execution_id: The execution ID (from subagent-result or /runs)
- files: Array of {source, destination?, added?, removed?} mappings
  - source: File path within the run (as listed by /runs/{id}/files)
  - destination: Workspace path to write to (defaults to source path)
  - added/removed: Pass through from the subagent-result output-files metadata

Example: Copy corrected file back to its original location:
  execution_id: "abc-123"
  files: [{source: "paper__correct__r0_gemini.tex", destination: "paper.tex", added: 12, removed: 5}]`,
  schema: SyncWorkflowFilesInputSchema,
}) {
  protected async execute(input: SyncWorkflowFilesInput): Promise<ToolResult> {
    const { execution_id, files } = input;
    const executionId = execution_id as ExecutionId;
    const runDir = path.join(TASK_RUNS_DIR, executionId);

    // Verify run directory exists
    if (!(await StorageFS.exists(runDir))) {
      throw new ToolError(
        `Run not found: ${executionId}. Use /runs to list available executions.`,
      );
    }

    // Phase 1: Validate and resolve all paths before writing anything
    const resolved = await Promise.all(
      files.map(async (mapping) => {
        // Source must not escape run directory
        if (getPathSegments(mapping.source).includes('..')) {
          throw new ToolError(
            `Source path must not contain '..': ${mapping.source}`,
          );
        }

        const sourceRelative = path.join(TASK_RUNS_DIR, executionId, mapping.source);
        const sourceAbsolute = StorageFS.fullPath(sourceRelative);

        if (!(await StorageFS.exists(sourceRelative))) {
          throw new ToolError(
            `Source file not found: ${mapping.source} in run ${executionId}. ` +
              `Use runs tool with path /runs/${executionId}/files to list available files.`,
          );
        }

        // Destination must resolve inside workspace (locatePath rejects traversals)
        const destPath = mapping.destination ?? mapping.source;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `Destination must be inside the workspace: ${destPath}`,
          );
        }

        return {
          sourceLocation: createRunStorageLocation(sourceAbsolute, mapping.source, executionId),
          destLocation: createWorkspaceLocation(dest.absolutePath, dest.relativePath),
          source: mapping.source,
          destination: dest.relativePath,
          added: mapping.added ?? null,
          removed: mapping.removed ?? null,
        };
      }),
    );

    // Phase 2: Copy each file to workspace via flexibleFS
    const results: string[] = [];
    const edits: { path: string; lineChanges?: { added: number; removed: number } }[] = [];

    for (const entry of resolved) {
      const destExists = await flexibleFS.exists(entry.destLocation);
      const content = await flexibleFS.read(entry.sourceLocation);
      await flexibleFS.write(entry.destLocation, content);

      const action = destExists ? 'replaced' : 'created';
      const mappingNote =
        entry.source !== entry.destination ? ` (from ${entry.source})` : '';
      const statsNote =
        entry.added !== null && entry.removed !== null
          ? ` [+${entry.added}/-${entry.removed}]`
          : '';
      results.push(`${action}: ${entry.destination}${mappingNote}${statsNote}`);

      const edit: { path: string; lineChanges?: { added: number; removed: number } } = {
        path: entry.destination,
      };
      if (entry.added !== null && entry.removed !== null) {
        edit.lineChanges = { added: entry.added, removed: entry.removed };
      }
      edits.push(edit);
    }

    const summary = `Synced ${files.length} file${files.length > 1 ? 's' : ''} from run ${executionId}`;
    return {
      summary,
      output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
      edits,
    };
  }
}
