/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files may live in run storage
 * (taskRuns/{executionId}/) or directly in the workspace, depending on the
 * agent's storage mode. This tool locates files in either location and copies
 * them into the workspace — the programmatic equivalent of the "Accept" button
 * in the progress view.
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
import {
  StorageFS,
  WorkspaceFS,
  flexibleFS,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';

// Local imports - history
import { AgentHistoryManager } from '@common/history/AgentHistoryManager';

import type { FileLocation } from '@shared/schemas';

// ============================================================================
// Schema
// ============================================================================

const FileMapping = z.strictObject({
  /** File path within the run (as shown by /executions/{id}/files). */
  run_path: z
    .string()
    .describe('File path within the run (as listed by /executions/{id}/files)'),
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
    'Execution ID (from subagent-result id attribute or /executions)',
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

Locates output files in run storage or the workspace (depending on storage
mode) and writes them to the workspace. Each file is shown to the user for
review before writing.

Example: Accept corrected file back to its original location:
  execution_id: "d4f5e6a7-1234-4b89-abcd-ef0123456789"
  files: [{run_path: "paper__correct__r0_gemini.tex", workspace_path: "paper.tex"}]`,
  schema: AcceptRunFilesInputSchema,
}) {
  protected async execute(input: AcceptRunFilesInput): Promise<ToolResult> {
    const { execution_id: executionId, files } = input;
    const runDir = path.join(TASK_RUNS_DIR, executionId);

    // Verify execution exists — run dir may not exist in workspace storage mode
    const runDirExists = await StorageFS.exists(runDir);
    if (!runDirExists) {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(executionId);
      if (!historyItem) {
        throw new ToolError(
          `Run not found: ${executionId}. Use /executions to list available executions.`,
        );
      }
    }

    // Phase 1: Validate all source paths and read content before any approvals
    const prepared = await Promise.all(
      files.map(async (mapping) => {
        if (getPathSegments(mapping.run_path).includes('..')) {
          throw new ToolError(
            `run_path must not contain '..': ${mapping.run_path}`,
          );
        }

        const { sourceAbsolute, sourceLocation } = await this.resolveSourceFile(
          executionId,
          mapping.run_path,
          runDirExists,
        );

        const destPath = mapping.workspace_path ?? mapping.run_path;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `workspace_path must be inside the workspace: ${destPath}`,
          );
        }

        const proposedContent = await flexibleFS.read(sourceLocation);
        const destExists = await WorkspaceFS.exists(dest.relativePath);

        // Determine original content for diff display
        const isSameFile =
          sourceLocation.kind === 'workspace' &&
          sourceAbsolute === dest.absolutePath;
        let originalContent: string;
        if (isSameFile) {
          originalContent = proposedContent;
        } else if (destExists) {
          originalContent = await WorkspaceFS.read(dest.relativePath);
        } else {
          originalContent = '';
        }

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
    const rejectionMessages: string[] = [];

    for (const entry of prepared) {
      const mappingNote =
        entry.runPath !== entry.workspacePath ? ` (from ${entry.runPath})` : '';

      const approval = await requestToolEditApproval({
        path: entry.workspacePath,
        originalContent: entry.originalContent,
        proposedContent: entry.proposedContent,
        sourceTool: 'accept_run_files',
      });

      if (!approval.accepted) {
        rejected++;
        if (approval.userMessage) rejectionMessages.push(approval.userMessage);
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
        rejectionMessages.join('\n'),
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

  /**
   * Resolves a source file by checking run storage first, then workspace.
   * In taskRunStorage mode, files live under StorageFS. In workspace mode,
   * files are written directly to the workspace.
   */
  private async resolveSourceFile(
    executionId: string,
    runPath: string,
    runDirExists: boolean,
  ): Promise<{ sourceAbsolute: string; sourceLocation: FileLocation }> {
    // Try run storage first
    if (runDirExists) {
      const rel = path.join(TASK_RUNS_DIR, executionId, runPath);
      if (await StorageFS.exists(rel)) {
        const abs = StorageFS.fullPath(rel);
        return {
          sourceAbsolute: abs,
          sourceLocation: createRunStorageLocation(abs, runPath, executionId),
        };
      }
    }

    // Fall back to workspace
    const wsLoc = WorkspaceFS.locatePath(runPath);
    if (
      wsLoc.kind !== 'external' &&
      (await WorkspaceFS.exists(wsLoc.relativePath))
    ) {
      return {
        sourceAbsolute: wsLoc.absolutePath,
        sourceLocation: createWorkspaceLocation(
          wsLoc.absolutePath,
          wsLoc.relativePath,
        ),
      };
    }

    throw new ToolError(
      `File not found in run storage or workspace: ${runPath}. ` +
        `Use executions tool with path /executions/${executionId}/files to list available files.`,
    );
  }
}
