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
// Path validation
// ============================================================================

/**
 * Validate that a relative path does not escape its parent directory.
 * Rejects paths containing ".." segments that could traverse upward.
 */
function assertNoTraversal(relativePath: string, label: string): void {
  const segments = getPathSegments(relativePath);
  if (segments.includes('..')) {
    throw new ToolError(
      `${label} must not contain '..' path segments: ${relativePath}`,
    );
  }
}

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

IMPORTANT: Before syncing, always review the output first — read a few lines or
check the diff to confirm the changes are acceptable.

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
        // Sanitize source — reject path traversal
        assertNoTraversal(mapping.source, 'Source path');
        const sourceRelative = path.join(TASK_RUNS_DIR, executionId, mapping.source);
        const sourceAbsolute = StorageFS.fullPath(sourceRelative);

        if (!(await StorageFS.exists(sourceRelative))) {
          throw new ToolError(
            `Source file not found: ${mapping.source} in run ${executionId}. ` +
              `Use runs tool with path /runs/${executionId}/files to list available files.`,
          );
        }

        // Sanitize destination — must resolve inside workspace
        const destPath = mapping.destination ?? mapping.source;
        assertNoTraversal(destPath, 'Destination path');
        const resolved = WorkspaceFS.locatePath(destPath);
        if (resolved.kind === 'external') {
          throw new ToolError(
            `Destination must be inside the workspace: ${destPath}`,
          );
        }

        const sourceLocation = createRunStorageLocation(
          sourceAbsolute,
          mapping.source,
          executionId,
        );
        const destLocation = createWorkspaceLocation(
          resolved.absolutePath,
          resolved.relativePath,
        );

        return {
          sourceLocation,
          destLocation,
          source: mapping.source,
          destination: resolved.relativePath,
        };
      }),
    );

    // Phase 2: Copy each file to workspace via flexibleFS
    const results: string[] = [];
    const edits: { path: string }[] = [];

    for (const { sourceLocation, destLocation, source, destination } of resolved) {
      const destExists = await flexibleFS.exists(destLocation);
      const content = await flexibleFS.read(sourceLocation);
      await flexibleFS.write(destLocation, content);

      const action = destExists ? 'replaced' : 'created';
      const mappingNote =
        source !== destination ? ` (from ${source})` : '';
      results.push(`${action}: ${destination}${mappingNote}`);
      edits.push({ path: destination });
    }

    const summary = `Synced ${files.length} file${files.length > 1 ? 's' : ''} from run ${executionId}`;
    return {
      summary,
      output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
      edits,
    };
  }
}
