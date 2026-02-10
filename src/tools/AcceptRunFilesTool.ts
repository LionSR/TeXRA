/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files live in run storage
 * (taskRuns/{executionId}/). This tool copies selected files from run
 * storage into the workspace, replacing local files — the programmatic
 * equivalent of the "Accept" button in the progress view.
 *
 * Each file goes through the standard tool edit approval flow (same diff
 * panel as write_file), so the user can review, edit, or reject each file.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - shared
import { ExecutionIdSchema } from '@shared/schemas';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  getApprovedContent,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';

// Local imports - utils
import { StorageFS, WorkspaceFS, flexibleFS, createRunStorageLocation } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';

// ============================================================================
// Schema
// ============================================================================

const FileMapping = z.strictObject({
  /** File path within the run (as shown by /runs/{id}/files). */
  run_path: z
    .string()
    .describe('File path within the run (as listed by /runs/{id}/files)'),
  /**
   * Workspace-relative path to write to.
   * If omitted, defaults to run_path (same relative path).
   */
  workspace_path: z
    .string()
    .nullish()
    .describe(
      'Workspace-relative destination path. Defaults to run_path if omitted.',
    ),
});

const AcceptRunFilesInputSchema = z.strictObject({
  /** Execution ID of the completed run (UUID). */
  execution_id: ExecutionIdSchema.describe(
    'Execution ID (from subagent-result id attribute or /runs)',
  ),
  /** Files to accept from run storage into the workspace. */
  files: z
    .array(FileMapping)
    .min(1)
    .describe('Files to copy from run storage to workspace'),
});

export type AcceptRunFilesInput = z.infer<typeof AcceptRunFilesInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

export class AcceptRunFilesTool extends defineTool({
  name: 'accept_run_files',
  description: `Accept output files from a completed run into the workspace.

Copies selected output files from a run into the workspace, replacing
existing files. Each file is shown to the user for review before writing.

Example: Accept corrected file back to its original location:
  execution_id: "d4f5e6a7-1234-4b89-abcd-ef0123456789"
  files: [{run_path: "paper__correct__r0_gemini.tex", workspace_path: "paper.tex"}]`,
  schema: AcceptRunFilesInputSchema,
}) {
  protected async execute(input: AcceptRunFilesInput): Promise<ToolResult> {
    const { execution_id: executionId, files } = input;
    const runDir = path.join(TASK_RUNS_DIR, executionId);

    // Verify run directory exists
    if (!(await StorageFS.exists(runDir))) {
      throw new ToolError(
        `Run not found: ${executionId}. Use /runs to list available executions.`,
      );
    }

    // Phase 1: Validate all source paths and read content before any approvals
    const prepared = await Promise.all(
      files.map(async (mapping) => {
        if (getPathSegments(mapping.run_path).includes('..')) {
          throw new ToolError(
            `run_path must not contain '..': ${mapping.run_path}`,
          );
        }

        const sourceRelative = path.join(TASK_RUNS_DIR, executionId, mapping.run_path);
        const sourceAbsolute = StorageFS.fullPath(sourceRelative);

        if (!(await StorageFS.exists(sourceRelative))) {
          throw new ToolError(
            `File not found: ${mapping.run_path} in run ${executionId}. ` +
              `Use runs tool with path /runs/${executionId}/files to list available files.`,
          );
        }

        const destPath = mapping.workspace_path ?? mapping.run_path;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `workspace_path must be inside the workspace: ${destPath}`,
          );
        }

        const sourceLocation = createRunStorageLocation(sourceAbsolute, mapping.run_path, executionId);
        const proposedContent = await flexibleFS.read(sourceLocation);
        const destExists = await WorkspaceFS.exists(dest.relativePath);
        const originalContent = destExists ? await WorkspaceFS.read(dest.relativePath) : '';

        return {
          runPath: mapping.run_path,
          workspacePath: dest.relativePath,
          proposedContent,
          originalContent,
          destExists,
        };
      }),
    );

    // Phase 2: Request approval and write each file
    const results: string[] = [];
    const edits: ToolResult['edits'] = [];
    let rejected = 0;
    let lastRejectionMessage: string | undefined;

    for (const entry of prepared) {
      const approval = await requestToolEditApproval({
        path: entry.workspacePath,
        originalContent: entry.originalContent,
        proposedContent: entry.proposedContent,
        sourceTool: 'accept_run_files',
      });

      if (!approval.accepted) {
        rejected++;
        lastRejectionMessage = approval.userMessage ?? lastRejectionMessage;
        const mappingNote =
          entry.runPath !== entry.workspacePath ? ` (from ${entry.runPath})` : '';
        results.push(`rejected: ${entry.workspacePath}${mappingNote}`);
        continue;
      }

      const finalContent = getApprovedContent(approval, entry.proposedContent);
      await writeApprovedContent(
        entry.workspacePath,
        entry.originalContent,
        finalContent,
      );

      const action = entry.destExists ? 'replaced' : 'created';
      const mappingNote =
        entry.runPath !== entry.workspacePath ? ` (from ${entry.runPath})` : '';
      results.push(`${action}: ${entry.workspacePath}${mappingNote}`);
      edits.push({
        path: entry.workspacePath,
        lineChanges: approval.lineChanges,
        startLine: approval.startLine,
      });
    }

    // Single rejection → return rejection result
    if (rejected === files.length) {
      return buildApprovalRejectedResult(
        prepared[0].workspacePath,
        'accept_run_files',
        lastRejectionMessage,
      );
    }

    const accepted = files.length - rejected;
    const summary = `Accepted ${accepted}/${files.length} file${files.length > 1 ? 's' : ''} from run ${executionId}`;
    return {
      summary,
      output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
      edits,
    };
  }
}
