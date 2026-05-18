/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files live in task-run storage
 * (executions/{executionId}/). This tool copies those files into the workspace
 * — the programmatic equivalent of the "Accept" button in the progress view.
 *
 * Each file goes through the standard tool edit approval flow (same diff
 * panel as write_file), so the user can review, edit, or reject each file.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore } from '@agent/storage';

// Local imports - shared
import { generateDiffFileName } from '@latex/latexdiff/diffFileNameManager';
import { stripCriticizeAnnotations } from '@replacement/advanced';
import { ExecutionIdSchema } from '@shared/schemas';
import type { ExecutionId, FileLocation } from '@shared/schemas';

// Local imports - tools
import { requireRuntimeHost } from '@tools/contextHelpers';
import { ToolError, type ToolResult } from '@tools/result';
import { formatResultCount, pluralize } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  getApprovedContent,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';

// Local imports - utils
import {
  AbsoluteFS,
  StorageFS,
  WorkspaceFS,
  flexibleFS,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files';
import {
  getOriginalSnapshotPath,
  resolveStoragePath,
} from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';

// ============================================================================
// Schema
// ============================================================================

const FileMapping = z.strictObject({
  /** Output file path (matches `path` attribute in subagent-result XML). */
  path: z
    .string()
    .describe(
      'Output file path (matches path attribute in subagent-result delivery)',
    ),
  /**
   * Original workspace path to restore to (matches `original` attribute in
   * subagent-result XML). If omitted, defaults to path.
   */
  original: z
    .string()
    .nullish()
    .describe(
      'Original workspace path to write to (matches original attribute in delivery). Defaults to path if omitted.',
    ),
});

const AcceptRunFilesInputSchema = z.strictObject({
  /** Execution ID (matches `id` attribute in subagent-result XML). */
  execution_id: ExecutionIdSchema.describe(
    'Execution ID (matches id attribute in subagent-result delivery)',
  ),
  /** Files to accept from run storage into the workspace. */
  files: z
    .array(FileMapping)
    .min(1)
    .describe('Files to copy from run storage to workspace'),
  /** If true, strip `\criticize{...}{...}{...}` annotations before approval. */
  strip_criticize: z
    .boolean()
    .nullish()
    .describe(
      'If true, remove all \\criticize{...}{...}{...} LaTeX annotations from each file before approval. Use when accepting output from critique-style agents that embed review markers.',
    ),
});

export type AcceptRunFilesInput = z.infer<typeof AcceptRunFilesInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

export class AcceptRunFilesTool extends defineTool({
  name: 'accept_run_files',
  description: `Accept output files from a completed workflow run into the workspace.

Use this tool ONLY for workflow subagent results (category="workflow").
Do NOT use it for tool-use subagent results — those produce text responses,
not output files.

Locates output files in task-run storage and writes them to the workspace.
Each file goes through an approval step before writing and may be rejected.

Parameters map directly to subagent-result delivery attributes:
  execution_id ← <subagent-result id="...">
  path         ← <file path="...">
  original     ← <file original="...">

Example — given delivery:
  <subagent-result id="a1b2c3d4" agent="correct" category="workflow" status="completed">
    <file path="paper__correct__r0_gemini.tex" original="paper.tex" added="42" removed="15" />
  </subagent-result>

Call:
  execution_id: "a1b2c3d4"
  files: [{path: "paper__correct__r0_gemini.tex", original: "paper.tex"}]

Optional:
  strip_criticize  when true, remove all \\criticize{...}{...}{...} annotations from accepted files before the approval diff`,
  schema: AcceptRunFilesInputSchema,
}) {
  protected async execute(input: AcceptRunFilesInput): Promise<ToolResult> {
    const { execution_id: executionId, files, strip_criticize } = input;
    const runtimeHost = requireRuntimeHost('accept_run_files');

    const runDir = await resolveStoragePath(executionId);
    const runDirExists = runDir !== undefined;

    // Verify execution exists — run dir may not exist in workspace storage mode
    if (!runDirExists) {
      const exists = await getExecutionStore(executionId as ExecutionId).exists(
        'meta',
      );
      if (!exists) {
        throw new ToolError(
          `Run not found: ${executionId}. Use /executions to list available executions.`,
        );
      }
    }

    // Phase 1: Validate all source paths and read content before any approvals
    const prepared = await Promise.all(
      files.map(async (mapping) => {
        if (getPathSegments(mapping.path).includes('..')) {
          throw new ToolError(`path must not contain '..': ${mapping.path}`);
        }

        const { sourceAbsolute, sourceLocation } = await this.resolveSourceFile(
          executionId,
          mapping.path,
          runDirExists,
        );

        const destPath = mapping.original ?? mapping.path;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `original must be inside the workspace: ${destPath}`,
          );
        }

        const rawContent = await flexibleFS.read(sourceLocation);
        const { content: proposedContent, count: strippedCount } =
          strip_criticize
            ? stripCriticizeAnnotations(rawContent)
            : { content: rawContent, count: 0 };
        const destExists = await WorkspaceFS.exists(dest.relativePath);

        // Determine original content for diff display. In-place workflow
        // outputs can make source and destination the same workspace file, so
        // the pre-run snapshot is the only reliable "before" image.
        const snapshotPath = getOriginalSnapshotPath(
          executionId,
          dest.relativePath,
        );
        const snapshotContent = (await AbsoluteFS.isFile(snapshotPath))
          ? await AbsoluteFS.read(snapshotPath)
          : undefined;
        const isSameFile =
          sourceLocation.kind === 'workspace' &&
          sourceAbsolute === dest.absolutePath;
        let originalContent: string;
        if (snapshotContent !== undefined) {
          originalContent = snapshotContent;
        } else if (isSameFile) {
          originalContent = rawContent;
        } else if (destExists) {
          originalContent = await WorkspaceFS.read(dest.relativePath);
        } else {
          originalContent = '';
        }

        return {
          path: mapping.path,
          original: dest.relativePath,
          destAbsolutePath: dest.absolutePath,
          proposedContent,
          originalContent,
          destExists,
          strippedCount,
        };
      }),
    );

    // Phase 2: Request approval and write each file
    const results: string[] = [];
    const edits: ToolResult['edits'] = [];
    const acceptedEntries: {
      outputPath: string;
      originalPath: string;
      destAbsolutePath: string;
    }[] = [];
    let rejected = 0;
    let unchanged = 0;
    let firstRejectedPath: string | undefined;
    const rejectionMessages: string[] = [];

    let totalStripped = 0;

    for (const entry of prepared) {
      const mappingNote =
        entry.path !== entry.original ? ` (from ${entry.path})` : '';

      if (entry.originalContent === entry.proposedContent) {
        unchanged++;
        results.push(`unchanged: ${entry.original}${mappingNote}`);
        continue;
      }

      const approval = await requestToolEditApproval({
        path: entry.original,
        originalContent: entry.originalContent,
        proposedContent: entry.proposedContent,
        sourceTool: 'accept_run_files',
      });

      if (!approval.accepted) {
        rejected++;
        firstRejectedPath ??= entry.original;
        if (approval.userMessage) rejectionMessages.push(approval.userMessage);
        results.push(`rejected: ${entry.original}${mappingNote}`);
        continue;
      }

      const finalContent = getApprovedContent(approval, entry.proposedContent);
      await writeApprovedContent(
        entry.original,
        entry.originalContent,
        finalContent,
      );

      const action = entry.destExists ? 'replaced' : 'created';
      const strippedNote =
        entry.strippedCount > 0
          ? ` (stripped ${entry.strippedCount} \\criticize)`
          : '';
      totalStripped += entry.strippedCount;
      results.push(`${action}: ${entry.original}${mappingNote}${strippedNote}`);
      edits.push({
        path: entry.original,
        lineChanges: approval.lineChanges,
        startLine: approval.startLine,
      });
      acceptedEntries.push({
        outputPath: entry.path,
        originalPath: entry.original,
        destAbsolutePath: entry.destAbsolutePath,
      });
    }

    // Badge all accepted workspace files
    if (acceptedEntries.length > 0) {
      runtimeHost.emit('workspaceFilesWritten', {
        absolutePaths: acceptedEntries.map((e) => e.destAbsolutePath),
      });
    }

    const changed = files.length - unchanged;

    if (changed === 0) {
      const summary = `No changes to accept from run ${executionId}`;
      return {
        summary,
        output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
        edits,
      };
    }

    // All changed files rejected → return rejection result
    if (rejected === changed && acceptedEntries.length === 0) {
      return buildApprovalRejectedResult(
        firstRejectedPath ?? prepared[0].original,
        'accept_run_files',
        rejectionMessages.join('\n'),
      );
    }

    // Phase 3: Clean up diff files from workspace for accepted files
    const cleaned = await this.cleanupDiffFiles(acceptedEntries);
    for (const f of cleaned) {
      results.push(`cleaned: ${f}`);
    }

    const accepted = acceptedEntries.length;
    const strippedSuffix =
      totalStripped > 0
        ? ` (stripped ${formatResultCount(totalStripped, '\\criticize annotation')})`
        : '';
    const unchangedSuffix =
      unchanged > 0
        ? ` (${formatResultCount(unchanged, 'unchanged file')})`
        : '';
    const summary = `Accepted ${accepted}/${changed} changed ${pluralize(changed, 'file')} from run ${executionId}${strippedSuffix}${unchangedSuffix}`;
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
    // Try run storage first (primary then legacy)
    if (runDirExists) {
      const rel = await resolveStoragePath(executionId, runPath);
      if (rel) {
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

  /**
   * Remove diff files from the workspace that correspond to accepted output files.
   * Uses generateDiffFileName (the same logic that creates diff files) to derive names.
   */
  private async cleanupDiffFiles(
    entries: { outputPath: string; originalPath: string }[],
  ): Promise<string[]> {
    const results = await Promise.all(
      entries.map(async ({ outputPath, originalPath }) => {
        const diffFileName = generateDiffFileName(
          originalPath,
          outputPath,
          '_diff',
        );
        const dir = path.dirname(originalPath);
        const fullDiffPath =
          dir === '.' ? diffFileName : `${dir}/${diffFileName}`;

        const loc = WorkspaceFS.locatePath(fullDiffPath);
        if (loc.kind === 'external') return null;

        try {
          await WorkspaceFS.delete(loc.relativePath);
          return loc.relativePath;
        } catch {
          // Non-fatal: file may not exist or may be locked
          return null;
        }
      }),
    );

    return results.filter((f): f is string => f !== null);
  }
}
