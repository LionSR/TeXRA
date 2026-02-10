/**
 * Tool for syncing workflow-generated files back to the workspace.
 *
 * After a workflow agent completes, its output files live in run storage
 * (taskRuns/{executionId}/). This tool copies selected files from run
 * storage into the workspace, replacing local files. The orchestrator
 * uses this to "accept" workflow results without manually reading and
 * writing each file.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { StorageFS, WorkspaceFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';

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

/**
 * Sync workflow-generated files from run storage to the workspace.
 *
 * Usage:
 *   execution_id: "abc-123"
 *   files: [
 *     { source: "paper__correct__r0_gemini.tex", destination: "paper.tex" },
 *     { source: "appendix__correct__r0_gemini.tex", destination: "appendix.tex" }
 *   ]
 *
 * Each file is read from taskRuns/{execution_id}/{source} and written to
 * the workspace at {destination} (or {source} if destination is omitted).
 */
export class SyncWorkflowFilesTool extends defineTool({
  name: 'sync_workflow_files',
  description: `Sync workflow-generated files from run storage to the workspace.

Copies selected output files from a completed workflow run into the workspace,
replacing existing files. Use after reviewing workflow results via the runs tool.

Parameters:
- execution_id: The execution ID (from subagent-result or /runs)
- files: Array of {source, destination?} mappings
  - source: File path within the run (as listed by /runs/{id}/files)
  - destination: Workspace path to write to (defaults to source path)

Example: Copy corrected file back to its original location:
  execution_id: "abc-123"
  files: [{source: "paper__correct__r0_gemini.tex", destination: "paper.tex"}]`,
  schema: SyncWorkflowFilesInputSchema,
}) {
  protected async execute(input: SyncWorkflowFilesInput): Promise<ToolResult> {
    const { execution_id, files } = input;
    const runDir = path.join(TASK_RUNS_DIR, execution_id);

    // Verify run directory exists
    if (!(await StorageFS.exists(runDir))) {
      throw new ToolError(
        `Run not found: ${execution_id}. Use /runs to list available executions.`,
      );
    }

    // Phase 1: Validate all source files exist before writing anything
    const resolved = await Promise.all(
      files.map(async (mapping) => {
        const sourcePath = path.join(runDir, mapping.source);
        const exists = await StorageFS.exists(sourcePath);
        if (!exists) {
          throw new ToolError(
            `Source file not found: ${mapping.source} in run ${execution_id}. ` +
              `Use runs tool with path /runs/${execution_id}/files to list available files.`,
          );
        }
        const destination = mapping.destination ?? mapping.source;
        return { sourcePath, source: mapping.source, destination };
      }),
    );

    // Phase 2: Copy each file to workspace
    const results: string[] = [];
    const edits: { path: string; lineChanges?: { added: number; removed: number } }[] = [];

    for (const { sourcePath, source, destination } of resolved) {
      const content = await StorageFS.read(sourcePath);
      const newLines = content.split('\n').length;

      // Check if destination exists and count original lines for diff stats
      const destExists = await WorkspaceFS.exists(destination);
      let removedLines = 0;
      if (destExists) {
        const original = await WorkspaceFS.read(destination);
        removedLines = original.split('\n').length;
      }

      await WorkspaceFS.write(destination, content);

      const action = destExists ? 'replaced' : 'created';
      const mappingNote =
        source !== destination ? ` (from ${source})` : '';
      results.push(`${action}: ${destination}${mappingNote}`);
      edits.push({
        path: destination,
        lineChanges: { added: newLines, removed: removedLines },
      });
    }

    const summary = `Synced ${files.length} file${files.length > 1 ? 's' : ''} from run ${execution_id}`;
    return {
      summary,
      output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
      edits,
    };
  }
}
